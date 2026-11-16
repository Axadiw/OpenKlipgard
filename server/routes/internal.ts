import { Router } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { getUserByEmail, getUserByUuid, getFtpsState } from '../db/queries/users.js';
import {
  getUserQuota, updateDiskUsage, updateTransferUsage, checkAndResetTransfer,
  getAutoDeleteOldest, recordUpload,
} from '../db/queries/storage.js';
import {
  isUserLocked, isUserBanned, recordFailedLogin, resetLoginAttempts, isIpLocked, recordFailedLoginByIp,
} from '../db/queries/lockout.js';
import { createNotification } from '../db/queries/notifications.js';
import { withVariantLocKey } from '../services/notificationLocKeys.js';
import { getFileMetadataSize } from '../db/queries/events.js';
import { isIP } from 'net';
import { headObject } from '../services/s3.js';
import { completeUpload } from '../services/ingest/completeUpload.js';
import { deleteSidecarsForRecording } from '../services/fileLifecycle.js';

// HeadObject backoff schedule for /file-uploaded. Sleeps BETWEEN attempts, so
// length == retries (4 attempts total = 3 retries with these waits + the
// initial try). Transient AWS UnknownError / network blips after a fresh PUT
// nearly always clear within the first retry; the 900ms tail catches the rare
// SDK timeout-then-reconnect cycle. Max total wall time on full exhaustion:
// ~1.3s, well under any FTPS-side timeout.
const HEAD_OBJECT_RETRY_DELAYS_MS = [100, 300, 900];

async function headObjectWithRetry(
  bucket: string,
  key: string,
  salt: string,
): Promise<Awaited<ReturnType<typeof headObject>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= HEAD_OBJECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await headObject(bucket, key, salt);
    } catch (err) {
      lastErr = err;
      if (attempt === HEAD_OBJECT_RETRY_DELAYS_MS.length) break;
      await new Promise<void>(resolve => setTimeout(resolve, HEAD_OBJECT_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}
import { publishThumbnailUnique, clearThumbnailDedup } from '../services/streamsClient.js';
import { evictUserToFitPlan } from '../services/quotaTidy.js';
import {
  reconcileUserQuota, STORAGE_WARN_EMAIL_THRESHOLD, QUOTA_WARN_THRESHOLD,
} from '../services/quota-reconciler.js';
import type { NotificationKind } from '../types.js';
import { isAccessLocked } from '../db/queries/access.js';
import { signInRefusal } from '../hooks.js';
import { verifyPassword, DUMMY_HASH } from '../services/auth.js';
import { preAuthBlocked, recordUnknownUserFailure } from '../services/preAuthThrottle.js';
import {
  recordFtpsUploadAborted, recordFtpsUploadCompleted, uploadExtBucket, originFor,
  recordFtpsLogin,
} from '../utils/metrics.js';

const router = Router();

/**
 * Internal API middleware: verify X-Internal-Key header.
 * These routes are reachable only from in-cluster pods (FTPS / workers),
 * enforced by layered controls:
 *   1. App host-header guard (server/index.ts): rejects with 404 if
 *      X-Forwarded-Host / Host matches CONFIG.publicHosts (exact/suffix).
 *   2. This timing-safe X-Internal-Key check: returns 403 on mismatch.
 *   3. k8s ingress only routes /api/, and nginx.conf returns 403 for
 *      /internal/ — so the path is never proxied from the public edge.
 */
router.use((req, res, next) => {
  const key = String(req.headers['x-internal-key'] ?? '');
  if (!CONFIG.internalApiKey || key.length !== CONFIG.internalApiKey.length ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(CONFIG.internalApiKey))) {
    res.status(403).json({ error: 'Invalid internal API key' });
    return;
  }
  next();
});

/**
 * The hash a camera login is checked against. Passkey-enabled users
 * authenticate FTPS via the dedicated `ftps_password_hash`; the main
 * `password_hash` is rejected so a phished web password can't pivot to camera
 * uploads. Defensive: a passkey user with no FTPS password set (or no user at
 * all) gets DUMMY_HASH, which keeps timing flat AND never verifies.
 */
async function ftpsTargetHash(user: { internalId: number; passwordHash: string | null } | null | undefined): Promise<string> {
  if (!user) return DUMMY_HASH;
  const ftps = await getFtpsState(user.internalId);
  if (ftps?.passkeyEnabled || user.passwordHash === null) {
    return ftps?.ftpsPasswordHash ?? DUMMY_HASH;
  }
  return user.passwordHash;
}

/**
 * A non-reversible fingerprint of the credential an FTP session was opened
 * with. It changes when that credential changes (password change, FTPS
 * password rotate/clear, passkey enable/removal) and NOT on a web "sign out
 * everywhere", so cameras are not dropped by that.
 */
const sessionEpoch = (hash: string): string => createHash('sha256').update(hash).digest('hex').slice(0, 32);

/**
 * The account-state checks that apply AFTER the password was proven (and, for
 * a live session, instead of it). Order matters for /auth/verify's answers.
 */
async function ftpsAccountRefusal(user: NonNullable<Awaited<ReturnType<typeof getUserByEmail>>>): Promise<string | null> {
  // Admin users cannot use FTPS (they don't have recordings)
  if (user.isAdmin) return 'admin_not_allowed';
  // A locked account keeps its web sign-in but not its cameras.
  if (await isAccessLocked(user.internalId)) return 'access_locked';
  // An account that may not sign in on the web may not use its cameras
  // either: one an admin has not activated yet, or (Cloud) one whose address
  // is not confirmed — a paid sign-up is unlocked by the payment before the
  // owner clicks the link.
  if (user.active === false) return 'inactive';
  if (signInRefusal(user)) return 'email_not_verified';
  return null;
}

/**
 * POST /internal/auth/verify
 * FTPS server calls this to authenticate camera users.
 * Body: { username, password }
 * Returns: { valid, userId, userUuid, encryptionSalt, origin } or { valid: false }
 */
router.post('/auth/verify', async (req, res) => {
  try {
    // Wire-protocol field name stays `username` because the FTPS server
    // forwards the camera's FTP user verbatim. Cameras now send their email
    // as the FTP login; we look that up against the email column.
    const { username, password } = req.body;
    if (!username || !password) {
      res.json({ valid: false });
      return;
    }

    // Real client IP forwarded by the FTPS server (X-Real-Client-IP). req.ip
    // here would be the shared FTPS pod IP — useless as a per-camera throttle
    // key — so we key the credential-spray throttle on this header instead.
    // Validate it's a real IP before trusting it as an inet subject.
    const rawClientIp = req.headers['x-real-client-ip'];
    const clientIp = typeof rawClientIp === 'string' && isIP(rawClientIp) ? rawClientIp : null;

    // Credential-spray guard: reject every FTPS auth from an IP that tripped the
    // per-IP failed-login threshold across many usernames, before touching the
    // user row or comparing any password.
    if (clientIp) {
      const ipLock = await isIpLocked(clientIp);
      if (ipLock.locked) {
        res.json({ valid: false, ipLocked: true, lockedUntil: ipLock.lockedUntil });
        return;
      }
    }

    // An address that spent its budget of unknown-username guesses is refused
    // before the lookup and any bcrypt: such a guess advances no account counter.
    if (preAuthBlocked(clientIp)) {
      res.json({ valid: false, ipLocked: true });
      return;
    }

    const user = await getUserByEmail(String(username).toLowerCase());

    // Ban (admin suspension) and lockout (failed-login backoff) are read before
    // the password but answered only after it, so nobody who just knows an
    // e-mail address can read the account's state ([API-EVENTS-205]).
    // Only the FTP channel's lockout applies here: failed web sign-ins never
    // stop the cameras.
    const banStatus = user ? await isUserBanned(user.internalId) : null;
    const lockStatus = user ? await isUserLocked(user.internalId, 'ftp', clientIp) : null;

    const targetHash = await ftpsTargetHash(user);
    const valid = await verifyPassword(password, targetHash);
    if (!user || !valid) {
      // A locked channel counts no more failures, as before the password moved first.
      if (user && !lockStatus?.locked) {
        // Per-account backoff on the FTP channel (short lockout of this
        // account's FTP logins — the web sign-in is unaffected) AND the per-IP
        // credential-spray counter (long lockout on the whole IP once it has
        // failed against enough distinct valid accounts). Only real accounts
        // advance the IP counter — an attach-point for the IP-scoped ban.
        await recordFailedLogin(user.internalId, 'ftp', clientIp);
        if (clientIp) await recordFailedLoginByIp(clientIp, user.internalId);
      } else if (!user) {
        // No account to count against: spend the address's unknown-user budget instead.
        recordUnknownUserFailure(clientIp);
      }
      res.json({ valid: false });
      return;
    }

    if (banStatus?.banned) {
      res.json({ valid: false, banned: true, bannedUntil: banStatus.until, reason: banStatus.reason });
      return;
    }
    if (lockStatus?.locked) {
      res.json({ valid: false, locked: true, lockedUntil: lockStatus.lockedUntil });
      return;
    }

    // Also checked after the password, so a wrong password never reveals the
    // account state.
    const refusal = await ftpsAccountRefusal(user);
    if (refusal) {
      res.json({ valid: false, reason: refusal });
      return;
    }

    await resetLoginAttempts(user.internalId, 'ftp', clientIp);

    // The ATTEMPT side of the ingest funnel. Counted here and not in the FTPS
    // server because every login really does reach this route (the moka cache
    // in ftps-server/src/auth.rs feeds the UserDetailProvider, it does not skip
    // verify_auth) and because the synthetic-vs-organic split lives on this
    // side. Paired with klipgard_ftps_uploads_completed_total, it is what lets
    // FtpsCamerasConnectingNothingLanding see cameras knocking while nothing
    // lands — the shape where sessions die inside CWD before STOR and so
    // increment no abort counter at all.
    const origin = originFor(user.id);
    recordFtpsLogin(origin);

    res.json({
      valid: true,
      userId: user.internalId,
      userUuid: user.id,
      encryptionSalt: user.encryptionSalt,
      // The FTPS server labels its own per-session metrics with this, so its
      // browsing-session counter can be read against the organic login count
      // above. The classification stays here; the FTPS server only echoes it.
      origin,
      // Lets the FTPS server re-validate this session later (session-check).
      sessionEpoch: sessionEpoch(targetHash),
    });
  } catch (err) {
    console.error('Internal auth verify error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ valid: false, error: 'Internal error' });
  }
});

/**
 * POST /internal/users/:uuid/session-check
 * The FTPS server asks this (cached ~30 s) before serving a command on an
 * already-open session, so a ban, lock, deactivation or credential change
 * cuts a live session instead of only the next login. Body: { sessionEpoch }.
 * A missing user is a 200 `not_found` body so the caller can tell it from an
 * older API without this route (404 there). Not a login: touches no lockout
 * counter and no login metric.
 */
router.post('/users/:uuid/session-check', async (req, res) => {
  try {
    const user = await getUserByUuid(req.params.uuid);
    if (!user) {
      res.json({ valid: false, reason: 'not_found' });
      return;
    }
    if ((await isUserBanned(user.internalId)).banned) {
      res.json({ valid: false, reason: 'banned' });
      return;
    }
    const refusal = await ftpsAccountRefusal(user);
    if (refusal) {
      res.json({ valid: false, reason: refusal });
      return;
    }
    const presented = String(req.body?.sessionEpoch ?? '');
    const current = sessionEpoch(await ftpsTargetHash(user));
    if (presented.length !== current.length ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(current))) {
      res.json({ valid: false, reason: 'credential_changed' });
      return;
    }
    res.json({ valid: true });
  } catch (err) {
    console.error('Internal session-check error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /internal/users/:uuid/quota
 * FTPS server checks quota before accepting uploads.
 */
router.get('/users/:uuid/quota', async (req, res) => {
  const user = await getUserByUuid(req.params.uuid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Lazy transfer reset
  await checkAndResetTransfer(user.internalId);

  const quota = await getUserQuota(user.internalId);
  if (!quota) {
    res.status(404).json({ error: 'Quota not found' });
    return;
  }

  // Expose the auto-delete flag so the FTPS server can decide whether to cap the
  // upload stream at the user's remaining disk headroom (TOCTOU
  // narrowing). Auto-delete-ON accounts intentionally over-commit then tidy, so
  // FTPS must NOT cap them; auto-delete-OFF accounts (which get rejected
  // post-upload anyway) get the headroom cap so a single over-quota STOR can't
  // stream up to the 100 GiB sanity cap before the authoritative claim deletes it.
  const autoDeleteOldest = await getAutoDeleteOldest(user.internalId);
  res.json({ ...quota, autoDeleteOldest, uploadsBlocked: await isAccessLocked(user.internalId) });
});

/**
 * POST /internal/users/:uuid/usage
 * FTPS server reports usage changes after upload/delete.
 * Body: { diskDelta, transferDelta } — both in bytes.
 */
router.post('/users/:uuid/usage', async (req, res) => {
  const user = await getUserByUuid(req.params.uuid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const { diskDelta, transferDelta } = req.body as { diskDelta?: number; transferDelta?: number };

  if (typeof diskDelta === 'number') {
    await updateDiskUsage(user.internalId, diskDelta);
  }
  if (typeof transferDelta === 'number') {
    await updateTransferUsage(user.internalId, transferDelta);
  }

  const quota = await getUserQuota(user.internalId);
  res.json({ ok: true, quota });
});

/**
 * POST /internal/users/:uuid/transfer-check
 * Lazy monthly transfer reset + return current values.
 * FTPS server calls this before accepting large uploads.
 */
router.post('/users/:uuid/transfer-check', async (req, res) => {
  const user = await getUserByUuid(req.params.uuid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const result = await checkAndResetTransfer(user.internalId);
  const quota = await getUserQuota(user.internalId);
  const locked = await isAccessLocked(user.internalId);

  res.json({
    transferUsageBytes: result.transferUsageBytes,
    transferResetAt: result.transferResetAt,
    transferLimitBytes: quota?.transferLimitBytes ?? 0,
    // A locked account transfers nothing. Otherwise a limit of 0 means "no
    // transfer limit" (no plan, or a plan that only caps disk) — the same
    // convention every other quota check uses. Comparing usage against it
    // would read 0 < 0 and block every upload.
    withinLimit: !locked && (!quota || quota.transferLimitBytes <= 0
      || result.transferUsageBytes < quota.transferLimitBytes),
  });
});


// ---------------------------------------------------------------------------
// Shared claim helper — used by /file-complete.
//
// Performs the quota claim sequence:
//   1. Unconditionally increment disk_usage_bytes.
//   2. Check plan limits (upper-bound guard + overBytes calculation).
//   3a. Under plan or unlimited → schedule inline quota-warning if threshold
//       crossed, return claimed:true.
//   3b. Over plan + auto_delete flag ON → fire-and-forget eviction, return
//       claimed:true.
//   3c. Over plan + flag OFF → roll back increment, return claimed:false.
//
// NOTE: recordUpload is intentionally NOT called here. Callers are responsible
// for calling it at the right time (old route: unconditionally on claimed=true
// fire-and-forget; new /file-complete route: only on result.created to avoid
// double-counting camera retransmits).
//
// Returned shape:
//   { claimed: true,  evicting: bool, overBytes: N }
//   { claimed: false, reason: string, bytes?: N, planLimitBytes?: N }
//   null when quota row is missing (caller should 404).
// ---------------------------------------------------------------------------
type ClaimResult =
  | { claimed: true; evicting: boolean; overBytes: number }
  | { claimed: false; reason: string; bytes?: number; planLimitBytes?: number };

async function claimDiskSpaceAndTidy(
  user: Awaited<ReturnType<typeof getUserByUuid>> & {},
  bytes: number,
  /** Size of the file itself. `bytes` is only what the counter grows by ([API-EVENTS-221]). */
  fileBytes: number = bytes,
): Promise<ClaimResult | null> {
  // [API-EVENTS-221] A claim of nothing new (a retransmission of a registered
  // key) or a smaller replacement never needs room: apply the difference and
  // accept. Refusing it would make FTPS delete the object that the existing
  // row describes.
  if (bytes <= 0) {
    if (bytes < 0) await updateDiskUsage(user.internalId, bytes);
    return { claimed: true, evicting: false, overBytes: 0 };
  }

  // Step 1: unconditional increment.
  await updateDiskUsage(user.internalId, bytes);

  // Step 2: are we over plan?
  const quota = await getUserQuota(user.internalId);
  if (!quota) return null; // caller responds 404

  // Step 2a: upper-bound guard. A single file larger than the entire plan
  // can never be made-room-for by eviction — the FIFO loop would delete every
  // pre-existing file AND the new file itself (since the new file becomes
  // the last surviving FIFO entry), wiping everything to "fit" an upload
  // that doesn't fit. That's silent data loss with a 226 success on the
  // wire. Reject upfront — FTPS will
  // delete the S3 object and surface FTP 552 to the camera.
  if (quota.diskLimitBytes > 0 && fileBytes > quota.diskLimitBytes) {
    await updateDiskUsage(user.internalId, -bytes);
    return {
      claimed: false,
      reason: 'File exceeds plan capacity',
      bytes: fileBytes,
      planLimitBytes: quota.diskLimitBytes,
    };
  }

  const overBytes =
    quota.diskLimitBytes > 0 ? Math.max(0, quota.diskUsageBytes - quota.diskLimitBytes) : 0;

  if (overBytes <= 0) {
    // Instant storage-warning: this accepted (under-plan) upload may have just
    // pushed the user across the 90% (email) or 95% (in-app) line.
    // reconcileUserQuota is otherwise only reached on admin plan changes + the
    // 1-min reconciler backstop, so an FTPS-only user filling their disk would
    // never be warned in real time. Fire only on an UPWARD threshold crossing
    // (not every near-limit upload), and fire-and-forget via setImmediate so a
    // warning email never delays the FTPS claim response. reconcileUserQuota
    // self-gates (auto-delete users + <90% return early) and its notification
    // is deduped, so a redundant call is a cheap no-op.
    if (quota.diskLimitBytes > 0) {
      const prevPct = (quota.diskUsageBytes - bytes) / quota.diskLimitBytes;
      const newPct = quota.diskUsageBytes / quota.diskLimitBytes;
      const crossedUp = (t: number) => prevPct < t && newPct >= t;
      if (crossedUp(STORAGE_WARN_EMAIL_THRESHOLD) || crossedUp(QUOTA_WARN_THRESHOLD)) {
        setImmediate(() => {
          reconcileUserQuota(user.internalId).catch((err) =>
            console.error('inline quota-warning trigger failed:', err instanceof Error ? err.message : err),
          );
        });
      }
    }
    return { claimed: true, evicting: false, overBytes: 0 };
  }

  // Step 3: over plan — branch on flag.
  if (await getAutoDeleteOldest(user.internalId)) {
    // Fire-and-forget eviction. Use setImmediate to release the request
    // quickly while keeping the same Node event loop.
    setImmediate(() => {
      evictUserToFitPlan(
        user.internalId,
        user.id,
        user.encryptionSalt as string,
      ).catch((err) =>
        console.error('quota-tidy post-upload trigger failed:', err instanceof Error ? err.message : err),
      );
    });
    return { claimed: true, evicting: true, overBytes };
  }

  // Flag off — undo the unconditional increment so FTPS can roll back.
  // Don't record this upload anywhere: it's about to be deleted from S3.
  await updateDiskUsage(user.internalId, -bytes);
  return { claimed: false, reason: 'Disk quota exceeded' };
}

/**
 * POST /internal/users/:uuid/file-complete
 *
 * Synchronous ingest endpoint (R1 pipeline): folds quota claim + DB
 * registration + event linking + thumbnail publish into ONE call that FTPS
 * makes after a successful STOR. Replaces the two-step
 * disk-claim-and-tidy → file-uploaded sequence.
 *
 * Body: { s3Bucket, s3Key, originalFilename, fileSizeBytes }
 *
 * Response sequence:
 *   403 — missing/wrong X-Internal-Key (middleware)
 *   404 — unknown :uuid
 *   400 — missing/invalid body fields or s3Key outside user prefix
 *   502 — HeadObject retries exhausted (S3 object deleted best-effort)
 *   507 { ok: false, claimed: false, reason: 'quota_exceeded' }
 *         — quota gate failed; FTPS must delete the S3 object
 *   200 { ok: true, claimed: true, created, state, eventId? }
 */
router.post('/users/:uuid/file-complete', async (req, res) => {
  try {
    // 1. User lookup by :uuid — same as /file-uploaded.
    const user = await getUserByUuid(req.params.uuid);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // 2. Body validation — same style/status codes as /file-uploaded.
    const { s3Bucket, s3Key, originalFilename, fileSizeBytes, truncated } = req.body as {
      s3Bucket?: string;
      s3Key?: string;
      originalFilename?: string;
      fileSizeBytes?: number;
      truncated?: boolean;
    };

    if (typeof s3Bucket !== 'string' || !s3Bucket
        || typeof s3Key !== 'string' || !s3Key
        || typeof originalFilename !== 'string'
        || typeof fileSizeBytes !== 'number' || !Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
      res.status(400).json({ error: 'Invalid file-complete payload' });
      return;
    }

    // Defense in depth (mirrors the /file-uploaded guard).
    const expectedPrefix = `${user.id}/`;
    if (!s3Key.startsWith(expectedPrefix)) {
      console.warn(`file-complete: rejecting cross-user s3Key for ${user.id}: ${s3Key}`);
      res.status(400).json({ error: 's3Key must be prefixed by user UUID' });
      return;
    }

    if (!user.encryptionSalt) {
      res.status(500).json({ error: 'User missing encryption salt' });
      return;
    }

    // A locked account takes no new recordings: refuse before claiming any
    // space. FTPS treats 507 as a rejection and deletes the uploaded object.
    if (await isAccessLocked(user.internalId)) {
      res.status(507).json({ ok: false, claimed: false, reason: 'access_locked' });
      return;
    }

    // 3. HeadObject verify with the same retry loop as /file-uploaded.
    try {
      await headObjectWithRetry(s3Bucket, s3Key, user.encryptionSalt);
    } catch (err) {
      // [FTPS-074] Retries exhausted. The object stays: HEAD failing says
      // nothing about the bytes, and FTPS keeps the object after a 5xx and
      // retries, so a later call (or the audit job) registers it.
      console.error(
        `file-complete: HeadObject exhausted retries for ${s3Bucket}/${s3Key}, keeping the S3 object:`,
        err instanceof Error ? err.message : err,
      );
      res.status(502).json({ error: 'Failed to read S3 LastModified' });
      return;
    }

    // 4. Quota claim via the extracted helper; 507 when not claimed.
    //    [API-EVENTS-222] The claim is idempotent per (bucket, key): the
    //    counter grows only by the difference to the registered row, so a
    //    retransmission claims 0 and a replacement claims the size change.
    const registeredBytes = (await getFileMetadataSize(user.internalId, s3Bucket, s3Key)) ?? 0;
    const claimBytes = fileSizeBytes - registeredBytes;
    const claimResult = await claimDiskSpaceAndTidy(user, claimBytes, fileSizeBytes);
    if (!claimResult) {
      res.status(404).json({ error: 'Quota lookup failed' });
      return;
    }
    if (!claimResult.claimed) {
      res.status(507).json({ ok: false, claimed: false, reason: 'quota_exceeded' });
      return;
    }

    // 5. Transactional register + link.
    let result;
    try {
      result = await completeUpload({
        userId: user.internalId,
        userUuid: user.id,
        s3Bucket,
        s3Key,
        originalFilename,
        fileSizeBytes,
        truncated: truncated === true,
      });
    } catch (err) {
      // The claim has no row behind it. Give it back, so the FTPS retry of
      // this call claims once ([API-EVENTS-227]).
      if (claimBytes !== 0) {
        await updateDiskUsage(user.internalId, -claimBytes).catch((undoErr) =>
          console.error('file-complete: claim rollback failed:', undoErr instanceof Error ? undoErr.message : undoErr),
        );
      }
      throw err;
    }

    // 5a. [API-EVENTS-226] The key was `ready` and came again with other bytes:
    //     the sidecars made from the old bytes would be served for the new
    //     ones. Delete them; the worker builds new ones from the job below.
    if ('sidecarsStale' in result && result.sidecarsStale) {
      await deleteSidecarsForRecording(s3Key).catch((err) =>
        console.warn('file-complete: stale sidecar delete failed:', err instanceof Error ? err.message : err),
      );
    }

    // 5b. The other half of the abort ratio. klipgard_ftps_uploads_aborted_total
    //     counts FILES the camera gave up on, so its denominator has to be files
    //     that landed — not events, because a dual-view pair is two files and one
    //     event and the share would read ~2x high. This counter is deliberately
    //     shaped like the abort one (same `ext` bucketing, same `origin`) so the
    //     ingest dashboard can divide them without a units mismatch. It counts
    //     every accepted file including camera retransmits, which is what "the
    //     upload finished" means from the camera's side.
    recordFtpsUploadCompleted(uploadExtBucket(originalFilename), originFor(user.id));

    // 6. Upload telemetry — only on FIRST registration so camera retransmits
    //    don't double-count. The claim (step 4) already incremented
    //    disk_usage_bytes; recordUpload covers the lifetime + 30-day counters.
    //    These are separate concerns: disk_usage_bytes tracks current storage,
    //    upload_lifetime_bytes / upload_30d_bytes track historical ingest.
    //    No double-count risk: claimDiskSpaceAndTidy does NOT call recordUpload.
    if (result.created) {
      recordUpload(user.internalId, fileSizeBytes).catch((err) =>
        console.error('file-complete: recordUpload failed:', err instanceof Error ? err.message : err),
      );
    }

    // 7. Publish thumbnail job when the file was successfully linked to an event.
    // Publish for BOTH 'pending_sidecar' and 'ready': 'ready' here means this
    // s3Key's file_metadata row was already 'ready' from an earlier upload of
    // the same key (the upsert above never downgrades it) — e.g. a camera
    // retransmission. FTPS no longer builds sidecars inline (removed in R2);
    // for these already-ready files the worker still generates the
    // THUMBNAIL, while its sidecar stage no-ops since the row is already
    // ready. For unplayable/not_applicable/unrecognized/duplicate → no publish.
    if ((result.state === 'pending_sidecar' || result.state === 'ready') && 'eventId' in result) {
      try {
        // Dual-view ingest race: when the 2nd view of an event arrives (a
        // separate file-complete), completeUpload merges it into the existing
        // event whose 1st-view sidecar job may still be in-flight under the
        // 600s SETNX dedup. publishThumbnailUnique would silently drop this
        // publish, so the worker — which only iterates the view snapshot it
        // loaded for the 1st-view job — never builds the 2nd view's sidecar.
        // events.playback_ready (BOOL_AND over both views) then stays FALSE
        // forever and the event is invisible in the playback-gated list. The
        // scanner used to recover this; R3 removed it. Clearing the dedup makes
        // every file-complete enqueue a fresh job that the worker re-evaluates
        // against the CURRENT view set, so the late-arriving view's sidecar is
        // built in real-time. The real-time per-file ingest is authoritative;
        // the dedup exists only to throttle the per-tick reconciler, which is
        // unaffected (it still SETNX-dedups its own publishes).
        await clearThumbnailDedup(result.eventId);
        await publishThumbnailUnique(result.eventId, result.ownerId, { notify: true });
        // A merge-artifact heal can split a previously merged view out into a
        // NEW event. Its file was linked (and usually sidecar-ready) long ago,
        // so the redrive never sees it — without this publish the event would
        // stay without a thumbnail forever. notify:false: the file was already
        // announced when it first arrived.
        for (const rehomedId of result.rehomedEventIds ?? []) {
          await publishThumbnailUnique(rehomedId, result.ownerId, { notify: false });
        }
      } catch (publishErr) {
        // Redrive heals within ~1 min — never fail the request.
        console.warn(
          'file-complete: publishThumbnailUnique failed (redrive will heal):',
          publishErr instanceof Error ? publishErr.message : publishErr,
        );
      }
    }

    // 8. Success.
    res.json({
      ok: true,
      claimed: true,
      created: result.created,
      state: result.state,
      eventId: 'eventId' in result ? result.eventId : undefined,
    });
  } catch (err) {
    console.error('file-complete error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const ALLOWED_NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set([
  'storage_quota_exceeded',
  'transfer_quota_exceeded',
  'invalid_file',
  'user_banned',
  // Retired kinds — pre-existing rows still render in the UI; nothing writes
  // new ones (DATA-069):
  //   - `auto_deleted_oldest` (Phase D — eviction is silent)
  //   - `thumbnail_failed` (the placeholder thumbnail is the visible signal; the
  //     thumbnail worker no longer creates it either)
]);

/**
 * POST /internal/ftps/upload-aborted
 * FTPS reports a STOR the client abandoned mid-stream (control connection
 * closed while bytes were still streaming to S3). The transfer task is
 * CANCELLED there, so nothing else in the system ever learns the recording
 * was lost — this is the only signal. Body: { ext, userUuid }. `ext` is
 * bucketed by the caller and re-bucketed here so a bad caller can't widen the
 * label set; `userUuid` is resolved to the bounded `origin` enum and then
 * discarded, so it decides a label without ever becoming one.
 *
 * The uuid is carried in the body rather than classified in the FTPS server so
 * the synthetic-account list lives in exactly one config
 * (KLIPGARD_SYNTHETIC_USER_UUIDS, read by utils/metrics.ts). An older FTPS pod
 * mid-rollout simply omits it and its aborts count as `organic` — the safe
 * direction, and it self-corrects as the DaemonSet finishes rolling.
 *
 * Deliberately fire-and-forget on the FTPS side and 204 here: it must never
 * add latency or a failure mode to the upload path.
 */
router.post('/ftps/upload-aborted', (req, res) => {
  const { ext, userUuid } = req.body as { ext?: string; userUuid?: string };
  recordFtpsUploadAborted(
    uploadExtBucket(String(ext ?? '')),
    originFor(typeof userUuid === 'string' ? userUuid : undefined),
  );
  res.status(204).end();
});

/**
 * POST /internal/notifications
 * FTPS + thumbnail-worker post user-facing notifications here.
 * Body: { userUuid, kind, message, details? }
 *
 * Storage-quota notifications are gated server-side by the user's
 * `auto_delete_oldest` flag. Users who opted into auto-delete don't want
 * "consider upgrading your plan" pings every time the FTPS hot path
 * temporarily fills the disk — the eviction loop handles it for them. FTPS
 * keeps calling this endpoint unconditionally on quota-press; the API drops
 * the row on the floor when auto-delete is on. 202 (vs 201) makes the
 * suppression visible in logs without breaking the FTPS happy path.
 */
router.post('/notifications', async (req, res) => {
  const { userUuid, kind, message, details } = req.body as {
    userUuid?: string;
    kind?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  if (!userUuid || !kind || !message) {
    res.status(400).json({ error: 'userUuid, kind, and message are required' });
    return;
  }
  if (!ALLOWED_NOTIFICATION_KINDS.has(kind as NotificationKind)) {
    res.status(400).json({ error: 'Invalid notification kind' });
    return;
  }
  const user = await getUserByUuid(userUuid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (kind === 'storage_quota_exceeded' && await getAutoDeleteOldest(user.internalId)) {
    res.status(202).json({ suppressed: true, reason: 'auto_delete_enabled' });
    return;
  }

  const notification = await createNotification(
    user.internalId,
    kind as NotificationKind,
    message,
    // API-EVENTS-295: off by default until the apps ship the catalog keys.
    CONFIG.notificationLocKeys ? withVariantLocKey(kind as NotificationKind, details) : details,
  );
  res.status(201).json({ id: notification.id });
});

export default router;
