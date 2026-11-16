// server/db/queries/lockout.ts
//
// Failed-login lockouts: the per-account tier (5 failures in a row on one
// login channel) and the per-IP credential-spray tier (FTP only), both
// persisted as `type = 'lockout'` rows in `user_bans`, plus the generic
// ban-row listing/cancel helpers those rows are managed through.
// `isUserBanned` reads manual bans too: the login paths are shared, and a
// self-hosted install simply never writes one. The writers (ban/unban,
// appeals) are cloud-only: server/cloud/db/queries/moderation.ts.
//
// Two login channels are counted and locked independently:
//   - 'web': HTTP sign-in (password, passkey, backup code, OAuth);
//   - 'ftp': camera FTP/FTPS logins (POST /internal/auth/verify).
// A camera that keeps retrying a stale password therefore never locks the
// owner out of the web, and failed web sign-ins never stop the cameras.
// Manual bans apply to both. A lockout row without a channel predates the
// split and blocks both until it expires.
//
// A lockout is keyed on the account AND the source address (`login_failures`,
// `user_bans.scope = 'account_ip'`): five wrong passwords from one address lock
// the account for that address only, so a stranger cannot lock the owner out
// from the owner's own address. Two further tiers sit next to it:
//   - the account-wide backstop: ACCOUNT_BACKSTOP_THRESHOLD consecutive
//     failures from any mix of addresses lock the account for every address
//     that has not signed in within KNOWN_SOURCE_DAYS (spreading guesses over
//     many addresses cannot beat the per-address limit);
//   - the per-address credential-spray lockout (scope 'ip', FTP only).
// LOCKOUT_THRESHOLD, ACCOUNT_BACKSTOP_THRESHOLD and KNOWN_SOURCE_DAYS are the
// tunable knobs. Row locks are always taken in the order
// users → login_failures → user_bans → ip_login_attempts.
import { eq, and, or, isNull, gt, sql, desc, inArray } from 'drizzle-orm';
import { db, withTx, type Tx } from '../index.js';
import { userBans, users, ipLoginAttempts, loginFailures } from '../schema/index.js';
import type { BanStatus } from '../../types.js';

// Patterns reference: server/db/queries/users.ts (top of file)

/** Sentinel expiry for indefinite bans — lets queries compare timestamps without branching. */
export const INDEFINITE_BAN_ISO = '9999-01-01T00:00:00.000Z';

/** Which login a failed attempt — and the lockout it may trip — belongs to. */
export type LoginChannel = 'web' | 'ftp';

/** Consecutive failures on one channel from one address that lock that address out of the account. */
export const LOCKOUT_THRESHOLD = 5;
/** Consecutive failures on one channel from any addresses that lock the account for every unknown address. */
export const ACCOUNT_BACKSTOP_THRESHOLD = 50;
/** An address the account signed in from within this many days is spared by the account-wide backstop. */
export const KNOWN_SOURCE_DAYS = 30;

/** The caller's address, or null when it has none: those callers share one bucket. */
export type SourceIp = string | null;
const src = (ip: SourceIp): string => ip ?? '::';
/** The first lockout on a channel; every further one in a row doubles. */
const LOCKOUT_BASE_SECONDS = 60;
// The lockouts of one channel in a row — a streak, which a success on that
// channel or a password change ends — double from one minute but are held at
// the channel's cap for the first LOCKOUT_CAPPED_TIERS of them: 60 min on the
// web, 15 min on FTP, so a camera retrying an outdated password is back soon
// after its owner fixes it. A streak that goes on past that is guessing, not a
// stale camera: from there the lockouts double again from the cap, up to
// LOCKOUT_CEILING_SECONDS, so it cannot continue at a steady rate forever.
export const LOCKOUT_CAP_SECONDS: Readonly<Record<LoginChannel, number>> = { web: 60 * 60, ftp: 15 * 60 };
export const LOCKOUT_CAPPED_TIERS = 8;
export const LOCKOUT_CEILING_SECONDS = 24 * 60 * 60;

/**
 * Length of the `tier`-th lockout in a row on `channel`. Web: 1, 2, 4, 8, 16,
 * 32, 60, 60, then 120, 240, 480, 960, 1440 … minutes. FTP: 1, 2, 4, 8, 15,
 * 15, 15, 15, then 30, 60, 120, 240, 480, 960, 1440 … minutes.
 */
export function lockoutSeconds(channel: LoginChannel, tier: number): number {
  const cap = LOCKOUT_CAP_SECONDS[channel];
  const t = Math.max(1, tier);
  if (t <= LOCKOUT_CAPPED_TIERS) return Math.min(LOCKOUT_BASE_SECONDS * 2 ** (t - 1), cap);
  return Math.min(cap * 2 ** (t - LOCKOUT_CAPPED_TIERS), LOCKOUT_CEILING_SECONDS);
}

// The users-row counters of each channel: consecutive failures and the
// lockout tier (how many lockouts in a row, which sets the next duration).
const COUNTERS = {
  web: {
    attempts: users.failedLoginAttempts,
    tier: users.lockoutCount,
    bump: { failedLoginAttempts: sql`${users.failedLoginAttempts} + 1` },
    trip: (tier: number) => ({ failedLoginAttempts: 0, lockoutCount: tier }),
    reset: { failedLoginAttempts: 0, lockoutCount: 0 },
  },
  ftp: {
    attempts: users.ftpFailedLoginAttempts,
    tier: users.ftpLockoutCount,
    bump: { ftpFailedLoginAttempts: sql`${users.ftpFailedLoginAttempts} + 1` },
    trip: (tier: number) => ({ ftpFailedLoginAttempts: 0, ftpLockoutCount: tier }),
    reset: { ftpFailedLoginAttempts: 0, ftpLockoutCount: 0 },
  },
} as const;

// ── Per-IP credential-spray throttle ────────────────────────────────────────
// The per-user lockout fires at 5 failures on a SINGLE account; it can't catch
// one IP spraying passwords across many usernames. These
// govern the per-IP lockout that does.
//
// Threshold/window tuning: a legitimate camera site sits behind ONE premises IP
// and its cameras normally auth with the correct password, so failures are rare
// (a password rotation lag, a mistyped credential). 20 failed FTPS auths against
// valid accounts within 15 minutes from a single IP is far above the "handful of
// failures" a shared-NAT site produces after a rotation, yet well below the
// hundreds/thousands a spray tool generates — so it stops spray without locking
// out a real multi-camera site. If a badly misconfigured large site does trip it,
// the lockout auto-expires and an admin can cancel it immediately from the ban
// list. Only failures against REAL accounts advance the counter (attempts on
// non-existent usernames can never succeed, so they're not the threat here and
// give the counter no attach-point).
const IP_FAILED_THRESHOLD = 20;
const IP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_LOCKOUT_BASE_SECONDS = 15 * 60; // first lockout: 15 min, then doubling
const IP_LOCKOUT_MAX_SECONDS = 24 * 60 * 60; // cap escalation at 24 h

/**
 * Is this account locked out of `channel` for a caller at `sourceIp`? That is
 * the case after a lockout earned from this very address, or an account-wide
 * (backstop, or from before the per-address keying) lockout — which spares an
 * address the account signed in from in the last {@link KNOWN_SOURCE_DAYS}
 * days. A lockout row without a channel predates the split and counts for both.
 * An IP-scoped spray lockout is not an account lockout — it blocks its address,
 * for every username, through {@link isIpLocked} — so it never counts here.
 */
export async function isUserLocked(
  internalId: number,
  channel: LoginChannel,
  sourceIp: SourceIp = null,
): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const ip = src(sourceIp);
  const [row] = await db
    .select({
      expiresAt: userBans.expiresAt,
      accountWide: sql<boolean>`${userBans.sourceIp} IS NULL`,
    })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'lockout'),
        or(
          isNull(userBans.sourceIp),
          and(eq(userBans.scope, 'account_ip'), eq(userBans.sourceIp, ip)),
        ),
        or(eq(userBans.channel, channel), isNull(userBans.channel)),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
        // An account-wide lock does not apply to an address the account has signed in from.
        sql`NOT (${userBans.sourceIp} IS NULL AND EXISTS (
          SELECT 1 FROM ${loginFailures} lf
           WHERE lf.user_id = ${internalId} AND lf.channel = ${channel} AND lf.source_ip = ${ip}
             AND lf.last_success_at > NOW() - make_interval(days => ${KNOWN_SOURCE_DAYS})))`,
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { locked: false, lockedUntil: null };
  const lockedUntil =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  return { locked: true, lockedUntil };
}

/**
 * Count a failed login on `channel` from `sourceIp`. The
 * {@link LOCKOUT_THRESHOLD}th failure in a row from that address locks the
 * account for that address for {@link lockoutSeconds} of the address's next
 * tier and starts its count again; the {@link ACCOUNT_BACKSTOP_THRESHOLD}th in
 * a row from any addresses locks the account-wide. The other channel is not
 * touched.
 */
export async function recordFailedLogin(
  internalId: number,
  channel: LoginChannel,
  sourceIp: SourceIp = null,
): Promise<void> {
  const counters = COUNTERS[channel];
  const ip = src(sourceIp);
  await withTx(async (tx) => {
    // The row lock this UPDATE takes serialises concurrent failures on the
    // same account, so exactly one of them can trip the account-wide lockout.
    const [row] = await tx
      .update(users)
      .set(counters.bump)
      .where(eq(users.id, internalId))
      .returning({ attempts: counters.attempts, tier: counters.tier });
    if (!row) return;

    if (row.attempts >= ACCOUNT_BACKSTOP_THRESHOLD) {
      // Start counting again and raise the tier so the next lockout is longer;
      // the lockout itself is a row in user_bans.
      const tier = row.tier + 1;
      await tx.update(users).set(counters.trip(tier)).where(eq(users.id, internalId));
      await tx.insert(userBans).values({
        userId: internalId,
        type: 'lockout',
        scope: 'account',
        channel,
        reason: null,
        // Counted from the database clock, like created_at (NOW() = the start
        // of this transaction): a JS Date.now() taken after waiting for the row
        // lock above would make the lockout longer than its tier.
        expiresAt: sql`NOW() + make_interval(secs => ${lockoutSeconds(channel, tier)})`,
      });
    }

    // One atomic upsert per (account, channel, address): concurrent failures
    // from the same address cannot lose a count.
    const [counted] = await tx
      .insert(loginFailures)
      .values({ userId: internalId, channel, sourceIp: ip, failedAttempts: 1 })
      .onConflictDoUpdate({
        target: [loginFailures.userId, loginFailures.channel, loginFailures.sourceIp],
        set: { failedAttempts: sql`${loginFailures.failedAttempts} + 1`, updatedAt: sql`now()` },
      })
      .returning({ attempts: loginFailures.failedAttempts });
    if (!counted || counted.attempts < LOCKOUT_THRESHOLD) return;

    // The guard in WHERE lets only one concurrent caller trip the lockout.
    const [tripped] = await tx
      .update(loginFailures)
      .set({
        failedAttempts: 0,
        lockoutCount: sql`${loginFailures.lockoutCount} + 1`,
      })
      .where(
        and(
          eq(loginFailures.userId, internalId),
          eq(loginFailures.channel, channel),
          eq(loginFailures.sourceIp, ip),
          gt(loginFailures.failedAttempts, LOCKOUT_THRESHOLD - 1),
        ),
      )
      .returning({ tier: loginFailures.lockoutCount });
    if (!tripped) return;
    await tx.insert(userBans).values({
      userId: internalId,
      type: 'lockout',
      scope: 'account_ip',
      channel,
      sourceIp: ip,
      reason: null,
      expiresAt: sql`NOW() + make_interval(secs => ${lockoutSeconds(channel, tripped.tier)})`,
    });
  });
}

/**
 * A successful login on `channel` from `sourceIp`: clear that channel's
 * account-wide counters and the address's own streak, and remember the address
 * as one the account signs in from (which the account-wide backstop spares).
 */
export async function resetLoginAttempts(
  internalId: number,
  channel: LoginChannel,
  sourceIp: SourceIp = null,
): Promise<void> {
  // Any lockout that blocks this login has expired or been cancelled — the
  // login could not have got here otherwise — so only the counters need resetting.
  await withTx(async (tx) => {
    await tx.update(users).set(COUNTERS[channel].reset).where(eq(users.id, internalId));
    const ip = src(sourceIp);
    await tx
      .insert(loginFailures)
      .values({ userId: internalId, channel, sourceIp: ip, lastSuccessAt: sql`now()` })
      .onConflictDoUpdate({
        target: [loginFailures.userId, loginFailures.channel, loginFailures.sourceIp],
        set: { failedAttempts: 0, lockoutCount: 0, lastSuccessAt: sql`now()`, updatedAt: sql`now()` },
      });
  });
}

/**
 * The account's password changed: forget the failed attempts and lockout tiers
 * on both channels and lift its active lockouts, which were earned against the
 * old password. Manual bans stay (a moderation decision). IP-scoped spray
 * lockouts block an address rather than the account, so they are lifted —
 * together with their address's failure counter and tier — only with
 * `includeIpLocks`, which only the operator's own action passes (the
 * self-hosted password sync): where anyone can hold an account, lifting them
 * on every password change would let a sprayer unblock its address by
 * changing its own password. Runs in the caller's transaction when given one.
 */
export async function clearLoginLockouts(
  internalId: number,
  opts: { includeIpLocks?: boolean } = {},
  tx?: Tx,
): Promise<void> {
  if (!tx) return withTx((t) => clearLoginLockouts(internalId, opts, t));
  // users → login_failures → user_bans → ip_login_attempts: the order every
  // writer in this module takes its row locks in, so concurrent ones cannot deadlock.
  await tx
    .update(users)
    .set({ ...COUNTERS.web.reset, ...COUNTERS.ftp.reset })
    .where(eq(users.id, internalId));
  await resetSourceCounters(tx, internalId);
  const lifted = await tx
    .update(userBans)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'lockout'),
        // The account's own lockouts: account-wide and per address. The
        // address-wide spray ones only with includeIpLocks.
        opts.includeIpLocks ? undefined : or(isNull(userBans.sourceIp), eq(userBans.scope, 'account_ip')),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .returning(liftedRow);
  await forgetIpAttempts(tx, lifted);
}

/** Forget the per-address failures and tiers of an account; the addresses it signed in from stay known. */
async function resetSourceCounters(tx: Tx, internalId: number): Promise<void> {
  await tx
    .update(loginFailures)
    .set({ failedAttempts: 0, lockoutCount: 0 })
    .where(eq(loginFailures.userId, internalId));
}

const liftedRow = {
  sourceIp: sql<string | null>`host(${userBans.sourceIp})`,
  scope: userBans.scope,
};

/**
 * Drop the spray counters (failures and tier) of the addresses whose lockouts
 * were just lifted, so a lifted IP lockout does not come back at a higher tier.
 */
async function forgetIpAttempts(
  tx: Tx,
  lifted: ReadonlyArray<{ sourceIp: string | null; scope: string | null }>,
): Promise<void> {
  // Only the address-wide spray rows have a counter in ip_login_attempts; a
  // per-account address lockout (scope 'account_ip') must not reset it.
  const ips = [
    ...new Set(
      lifted
        .filter((r) => r.scope === 'ip' || (r.scope === null && r.sourceIp !== null))
        .map((r) => r.sourceIp)
        .filter((ip): ip is string => ip !== null),
    ),
  ];
  if (ips.length > 0) await tx.delete(ipLoginAttempts).where(inArray(ipLoginAttempts.sourceIp, ips));
}

/**
 * Is this source IP currently blocked by a credential-spray lockout?
 *
 * Queries user_bans for an active IP-scoped lockout (source_ip match, not
 * cancelled, not expired). Cancelling the ban row via the admin DELETE route
 * (which sets cancelled_at) immediately unblocks the IP — this filter is what
 * makes the lockout admin-cancellable through the existing ban machinery.
 */
export async function isIpLocked(
  sourceIp: string,
): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const [row] = await db
    .select({ expiresAt: userBans.expiresAt })
    .from(userBans)
    .where(
      and(
        eq(userBans.sourceIp, sourceIp),
        eq(userBans.type, 'lockout'),
        // Only the address-wide spray rows (an old row with an address and no
        // scope is one); a per-account address lockout does not block the address.
        or(isNull(userBans.scope), eq(userBans.scope, 'ip')),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { locked: false, lockedUntil: null };
  const lockedUntil =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  return { locked: true, lockedUntil };
}

/**
 * Record a failed FTPS auth against a real account from `sourceIp` and, once the
 * per-IP failure count crosses the threshold within the rolling window, write an
 * IP-scoped `lockout` ban that blocks every subsequent FTPS auth from that IP
 * (across all usernames) via {@link isIpLocked}.
 *
 * `tripUserId` is the internal id of the account this failed attempt targeted;
 * the lockout row is attached to it so the ban surfaces in that user's
 * `GET /users/:uuid/bans` list and is cancellable via the existing DELETE route,
 * while `source_ip` is what actually scopes the block to the whole IP. It is an
 * FTP lockout: it never blocks the web sign-in, nor this account's FTP logins
 * from other addresses.
 *
 * Complements — never replaces — the per-account {@link recordFailedLogin} on
 * the 'ftp' channel: a single account seeing 5 failures still trips its own
 * (shorter) lockout first.
 */
export async function recordFailedLoginByIp(sourceIp: string, tripUserId: number): Promise<void> {
  await withTx(async (tx) => {
    // One atomic statement: concurrent failures from the same address each
    // count (a read-then-write of the absolute value lost increments).
    const counted = await tx.execute<{ failed_attempts: number }>(sql`
      INSERT INTO ip_login_attempts (source_ip, failed_attempts, window_started_at, lockout_count)
      VALUES (${sourceIp}, 1, now(), 0)
      ON CONFLICT (source_ip) DO UPDATE SET
        failed_attempts = CASE WHEN ip_login_attempts.window_started_at <= now() - make_interval(secs => ${IP_WINDOW_MS / 1000})
                               THEN 1 ELSE ip_login_attempts.failed_attempts + 1 END,
        window_started_at = CASE WHEN ip_login_attempts.window_started_at <= now() - make_interval(secs => ${IP_WINDOW_MS / 1000})
                                 THEN now() ELSE ip_login_attempts.window_started_at END
      RETURNING failed_attempts`);
    const attempts = Number(counted.rows[0]?.failed_attempts ?? 0);
    if (attempts < IP_FAILED_THRESHOLD) return;

    // Threshold tripped: escalate the tier, reset the counter + window. The
    // guard lets only one concurrent caller through to write the lockout.
    const tripped = await tx.execute<{ lockout_count: number }>(sql`
      UPDATE ip_login_attempts
         SET failed_attempts = 0, window_started_at = now(), lockout_count = lockout_count + 1
       WHERE source_ip = ${sourceIp} AND failed_attempts >= ${IP_FAILED_THRESHOLD}
      RETURNING lockout_count`);
    if (tripped.rows.length === 0) return;
    const tier = Number(tripped.rows[0].lockout_count);
    const lockoutSecs = Math.min(IP_LOCKOUT_BASE_SECONDS * Math.pow(2, tier - 1), IP_LOCKOUT_MAX_SECONDS);
    await tx.insert(userBans).values({
      userId: tripUserId,
      type: 'lockout',
      scope: 'ip',
      channel: 'ftp',
      reason: null,
      sourceIp,
      expiresAt: sql`NOW() + make_interval(secs => ${lockoutSecs})`,
    });
  });
}

export interface UserBanRow {
  id: number;
  type: 'manual' | 'lockout';
  reason: string | null;
  issuedBy: number | null;
  createdAt: string;
  expiresAt: string;
  indefinite: boolean;
  // Populated only for credential-spray IP lockouts; NULL for manual bans and
  // per-user lockouts. Normalised with host() so admins see a bare address
  // (e.g. 203.0.113.5) — a raw inet SELECT would serialize the /32 host mask.
  sourceIp: string | null;
  // The login a lockout blocks ('web' or 'ftp'); NULL for manual bans and for
  // lockouts that predate the split (those block both).
  channel: LoginChannel | null;
  // What a lockout is keyed on; derived for rows from before the column.
  scope: 'account' | 'account_ip' | 'ip' | null;
}

/** List active bans for a user (admin UI). */
export async function listActiveBans(internalId: number): Promise<UserBanRow[]> {
  const rows = await db
    .select({
      id: userBans.id,
      type: userBans.type,
      reason: userBans.reason,
      issuedBy: userBans.issuedBy,
      createdAt: userBans.createdAt,
      expiresAt: userBans.expiresAt,
      // host() strips the /32 (IPv4) or /128 (IPv6) host mask that a plain
      // inet→text serialization would append; NULL passes through as NULL.
      sourceIp: sql<string | null>`host(${userBans.sourceIp})`,
      channel: userBans.channel,
      scope: userBans.scope,
    })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.createdAt));

  return rows.map((r) => {
    const expires =
      r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt);
    return {
      id: r.id,
      type: r.type as 'manual' | 'lockout',
      reason: r.reason ?? null,
      issuedBy: r.issuedBy ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      expiresAt: expires,
      indefinite: expires >= INDEFINITE_BAN_ISO,
      sourceIp: r.sourceIp ?? null,
      channel: r.channel ?? null,
      scope: r.type !== 'lockout' ? null : (r.scope ?? (r.sourceIp ? 'ip' : 'account')),
    };
  });
}

/**
 * Cancel a single ban by id. Returns false when the ban doesn't belong to the
 * given user (prevents an admin from cancelling bans across users via a crafted
 * path) or is already cancelled/expired.
 */
export async function cancelBan(banId: number, internalId: number): Promise<boolean> {
  const result = await db
    .update(userBans)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(userBans.id, banId),
        eq(userBans.userId, internalId),
        isNull(userBans.cancelledAt),
      ),
    )
    .returning({ id: userBans.id });

  return result.length > 0;
}

/**
 * Cancel ALL active bans of a user — manual bans, account lockouts on either
 * channel and the IP-scoped spray lockouts attached to the account — and reset
 * both channels' failed-login counters and lockout tiers, and the spray
 * counters of the addresses it unblocks, so the next failure starts from
 * scratch instead of re-locking at once or at a longer tier. Used by the
 * `reset-user-ban` operator script (unlike `unbanUser`, which only clears
 * manual bans via the admin UI).
 * Returns the number of bans cancelled.
 */
export async function cancelAllActiveBansForUser(internalId: number): Promise<number> {
  return withTx(async (tx) => {
    // Same lock order as clearLoginLockouts: users → login_failures → user_bans → ip_login_attempts.
    await tx
      .update(users)
      .set({ ...COUNTERS.web.reset, ...COUNTERS.ftp.reset })
      .where(eq(users.id, internalId));
    await resetSourceCounters(tx, internalId);

    const result = await tx
      .update(userBans)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(userBans.userId, internalId),
          isNull(userBans.cancelledAt),
          gt(userBans.expiresAt, new Date()),
        ),
      )
      .returning(liftedRow);
    await forgetIpAttempts(tx, result);

    return result.length;
  });
}

/** Active manual (moderation) ban for a user, if any. Never true on a self-hosted install. */
export async function isUserBanned(internalId: number): Promise<BanStatus> {
  const [row] = await db
    .select({ expiresAt: userBans.expiresAt, reason: userBans.reason })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'manual'),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { banned: false };
  const iso =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  const indefinite = iso >= INDEFINITE_BAN_ISO;
  return {
    banned: true,
    until: iso,
    reason: row.reason ?? undefined,
    indefinite,
  };
}
