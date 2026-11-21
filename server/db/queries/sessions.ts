import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { userSessions } from '../schema/sessions.js';
import { pushDevices } from '../schema/push.js';
import { users } from '../schema/users.js';
import { CONFIG } from '../../config.js';

// Per-device sessions (see server/db/schema/sessions.ts). The session id is the
// `sid` claim of the tokens issued for it.

function nextExpiry(): Date {
  return new Date(Date.now() + CONFIG.refreshTokenExpirySeconds * 1000);
}

/** Open a session for a sign-in and return its id. */
export async function createSession(userId: number): Promise<string> {
  const id = randomBytes(16).toString('base64url');
  await db.insert(userSessions).values({ id, userId, expiresAt: nextExpiry() });
  return id;
}

export type RefreshRotation =
  /** The presented token is the current one. The session moved to `seq`. */
  | { kind: 'rotated'; seq: number }
  /** The presented token was replaced a moment ago. `seq` is the current position. */
  | { kind: 'grace'; seq: number }
  /** The presented token was replaced earlier. The session is now revoked. */
  | { kind: 'reused' }
  /** The session is revoked, expired, deleted or another account's. */
  | { kind: 'gone' };

/**
 * Refresh a session ([API-CORE-063]). `presentedSeq` is the position the
 * refresh token carries. The row stays locked while the verdict is made, so
 * parallel refreshes of one session are told apart exactly.
 *
 * - Presented position equals the current one: the session moves one position
 *   up and its expiry moves out.
 * - Presented position is one behind and the session moved less than the grace
 *   window ago: a repeat. Nothing changes and the current position is returned.
 * - Any other older position: a reuse. The session is revoked.
 */
export async function rotateRefreshSession(
  id: string,
  userId: number,
  presentedSeq: number,
): Promise<RefreshRotation> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        seq: userSessions.refreshSeq,
        live: sql<boolean>`${userSessions.revokedAt} IS NULL AND ${userSessions.expiresAt} > now()`,
        inGrace: sql<boolean>`${userSessions.lastUsedAt} > now() - make_interval(secs => ${CONFIG.refreshReuseGraceSeconds})`,
      })
      .from(userSessions)
      .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId)))
      .for('update');
    if (!row || !row.live || presentedSeq > row.seq) return { kind: 'gone' };

    if (presentedSeq === row.seq) {
      const seq = row.seq + 1;
      await tx.update(userSessions)
        .set({ refreshSeq: seq, lastUsedAt: sql`now()`, expiresAt: nextExpiry() })
        .where(eq(userSessions.id, id));
      return { kind: 'rotated', seq };
    }

    if (presentedSeq === row.seq - 1 && row.inGrace) return { kind: 'grace', seq: row.seq };

    await tx.update(userSessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(userSessions.id, id));
    // As in revokeSession: the device's push registrations die with its session.
    await tx.delete(pushDevices).where(and(eq(pushDevices.sessionId, id), eq(pushDevices.userId, userId)));
    return { kind: 'reused' };
  });
}

/** End one session (sign-out on one device). Returns whether it was still live. */
export async function revokeSession(id: string, userId: number): Promise<boolean> {
  const rows = await db.update(userSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  // The device's push registrations die with its sign-in (the fan-out filter
  // is the authority; this is hygiene).
  await db.delete(pushDevices).where(and(eq(pushDevices.sessionId, id), eq(pushDevices.userId, userId)));
  return rows.length > 0;
}

/**
 * What requireAuth needs for a token that carries a session: the account's
 * token generation and whether the session still stands, in one round trip.
 * `tokenGeneration` is -1 when the user does not exist (never matches a token).
 */
export async function getSessionAuthState(
  userId: number,
  sessionId: string,
): Promise<{ tokenGeneration: number; sessionActive: boolean }> {
  const [row] = await db
    .select({ tokenGeneration: users.tokenGeneration, sessionId: userSessions.id })
    .from(users)
    .leftJoin(userSessions, and(
      eq(userSessions.id, sessionId),
      eq(userSessions.userId, users.id),
      isNull(userSessions.revokedAt),
    ))
    .where(eq(users.id, userId));
  if (!row) return { tokenGeneration: -1, sessionActive: false };
  return { tokenGeneration: row.tokenGeneration, sessionActive: row.sessionId !== null };
}

/** When the live (unrevoked) session `sessionId` of `userId` was signed in; null if none. */
export async function getSessionSignedInAt(userId: number, sessionId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: userSessions.createdAt })
    .from(userSessions)
    .where(and(
      eq(userSessions.id, sessionId),
      eq(userSessions.userId, userId),
      isNull(userSessions.revokedAt),
    ));
  return row?.createdAt ?? null;
}

/** Delete sessions whose refresh token has expired (revoked or not). */
export async function deleteExpiredSessions(): Promise<number> {
  const rows = await db.delete(userSessions)
    .where(lt(userSessions.expiresAt, new Date()))
    .returning({ id: userSessions.id });
  return rows.length;
}
