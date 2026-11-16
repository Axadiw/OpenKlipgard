// Self-service account endpoints: push-device registration and per-user
// push preferences. Mounted under `/api/v0/account` with requireAuth.
//
// Why a separate router from the admin-only /api/v0/users? Mixing admin +
// self-service in one bundle leads to bugs where a router-level
// `requireAdmin` accidentally locks out the self-service paths during
// refactor. Keeping them in two files makes the auth boundary visible.
// The cloud edition mounts its own self-service router (account deletion
// request — server/cloud/routes/account.ts) at the same prefix after this one.
import { Router } from 'express';
import crypto from 'crypto';
import {
  upsertPushDevice,
  upsertRelayPushDevice,
  ownsRelayDevice,
  deletePushDevice,
  upsertPushPrefs,
  getPushPrefs,
} from '../db/queries/push.js';
import { relayUrlFromEnv } from '../services/push/relayTransport.js';
import { relayIdentity } from '../services/push/relayIdentity.js';
import { registerString, TICKET_TTL_SECONDS } from '../services/push/relayProtocol.js';
import { ACCOUNT_NOTICES } from '../services/push/types.js';

const router = Router();

// Platforms we mint device tokens for. Reject anything else so a buggy client
// can't pollute the table with junk that the fan-out would then try to push to.
// The Mac registers directly with APNs (API-CORE-078) and never uses the relay,
// so the relay route takes a smaller set (API-CORE-080).
const ALLOWED_PUSH_PLATFORMS = new Set(['ios', 'android', 'macos']);
const ALLOWED_RELAY_PLATFORMS = new Set(['ios', 'android']);

// ---------------------------------------------------------------------------
// Push notifications — device registration + per-user delivery preferences.
//
// Mounted under `/api/v0/account` with requireAuth. The native iOS app calls
// these after obtaining an APNs device token. Registration upserts by token
// (a re-pointed token follows its current owner), so it is safe to call on
// every app launch.
// ---------------------------------------------------------------------------

/**
 * POST /api/v0/account/push-devices
 * Body: { token: string, platform: 'ios' | 'android' | 'macos', supportsLocKeys?: boolean }
 *
 * Upserts the device token onto the current user. APNs tokens are 64-byte hex
 * (128 chars) but we keep the length cap generous so FCM tokens (longer) fit.
 */
router.post('/push-devices', async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { token, platform, supportsLocKeys } = (req.body ?? {}) as {
    token?: unknown; platform?: unknown; supportsLocKeys?: unknown;
  };
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  if (typeof platform !== 'string' || !ALLOWED_PUSH_PLATFORMS.has(platform)) {
    res.status(400).json({ error: "platform must be one of 'ios', 'android', 'macos'" });
    return;
  }
  // Optional capability flag: clients that can render APNs loc-key/loc-args
  // localized alerts send `true`. Omitted/false → literal title/body (back-compat).
  await upsertPushDevice({
    userId, deviceToken: token, platform,
    supportsLocKeys: supportsLocKeys === true,
    sessionId: req.user?.sid ?? null,
    tokenGeneration: req.user?.tokenGen ?? null,
  });
  res.status(204).end();
});

/**
 * POST /api/v0/account/push-devices/relay
 * Body: { platform: 'ios' | 'android', publicKey: string, deviceId?: string }
 * (no 'macos': the Mac delivers straight to APNs, API-CORE-080)
 *
 * Registration for servers that deliver through the push relay. The app
 * sends its P-256 public key — NOT its push token — and gets back a short-
 * lived ticket signed by this server. It then presents that ticket, together
 * with the token, to the relay itself. This server ends up knowing how to
 * address and encrypt for the device, and never learns the token.
 *
 * `deviceId` lets an app that registered before keep its id (re-registering
 * on every launch is expected); it is only honoured for a device this
 * account already owns.
 */
router.post('/push-devices/relay', async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const relayUrl = relayUrlFromEnv();
  if (!relayUrl) {
    res.status(404).json({ error: 'Push is not configured on this server' });
    return;
  }
  const { platform, publicKey, deviceId } = (req.body ?? {}) as {
    platform?: unknown; publicKey?: unknown; deviceId?: unknown;
  };
  if (typeof platform !== 'string' || !ALLOWED_RELAY_PLATFORMS.has(platform)) {
    res.status(400).json({ error: "platform must be one of 'ios', 'android'" });
    return;
  }
  // Uncompressed P-256 point: 65 bytes → 87 base64url characters.
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) {
    res.status(400).json({ error: 'publicKey must be a base64url uncompressed P-256 point' });
    return;
  }
  let relayDeviceId: string = crypto.randomUUID();
  if (typeof deviceId === 'string' && /^[0-9a-f-]{36}$/.test(deviceId)) {
    if (await ownsRelayDevice(userId, deviceId)) relayDeviceId = deviceId;
  }
  try {
    const identity = await relayIdentity(relayUrl);
    await upsertRelayPushDevice({
      userId, relayDeviceId, publicKey, platform,
      sessionId: req.user?.sid ?? null, tokenGeneration: req.user?.tokenGen ?? null,
    });
    const expires = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
    res.json({
      relayUrl,
      instanceId: identity.instanceId,
      deviceId: relayDeviceId,
      platform,
      expires,
      signature: identity.sign(registerString(identity.instanceId, relayDeviceId, platform, expires)),
    });
  } catch (err) {
    console.error('Relay device registration failed:', err instanceof Error ? err.message : 'Unknown error');
    res.status(502).json({ error: 'The push relay is unreachable' });
  }
});

/**
 * DELETE /api/v0/account/push-devices/:token
 *
 * Unregister a device token for the current user (e.g. on logout / push
 * disable). Idempotent — 204 whether or not a row existed. The token is taken
 * from the path; it is URL-encoded by the client.
 */
router.delete('/push-devices/:token', async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = String(req.params.token);
  await deletePushDevice(userId, token);
  res.status(204).end();
});

/**
 * GET /api/v0/account/push-prefs
 * Returns the current user's push preferences (snooze window + per-category
 * toggles). Defaults to everything-on for a user who never set any.
 */
router.get('/push-prefs', async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(withoutAccountNotices(await getPushPrefs(userId)));
});

/**
 * PUT /api/v0/account/push-prefs
 * Body: { snoozeUntil?: ISO-8601 string | null, categories?: { [kind]: boolean } }
 *
 * Partial update: omit a field to leave it untouched; `snoozeUntil: null`
 * clears the do-not-disturb window. `categories`, when present, REPLACES the
 * stored map. Returns the resulting preferences.
 */
router.put('/push-prefs', async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const body = (req.body ?? {}) as { snoozeUntil?: unknown; categories?: unknown };

  const patch: { snoozeUntil?: string | null; categories?: Record<string, boolean> } = {};

  if ('snoozeUntil' in body) {
    const s = body.snoozeUntil;
    if (s === null) {
      patch.snoozeUntil = null;
    } else if (typeof s === 'string') {
      const ms = Date.parse(s);
      if (Number.isNaN(ms)) {
        res.status(400).json({ error: 'snoozeUntil must be an ISO-8601 datetime or null' });
        return;
      }
      // Normalise to a canonical ISO string so storage is consistent.
      patch.snoozeUntil = new Date(ms).toISOString();
    } else {
      res.status(400).json({ error: 'snoozeUntil must be an ISO-8601 datetime or null' });
      return;
    }
  }

  if ('categories' in body) {
    const c = body.categories;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      res.status(400).json({ error: 'categories must be an object of kind→boolean' });
      return;
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
      if (typeof v !== 'boolean') {
        res.status(400).json({ error: `categories.${k} must be a boolean` });
        return;
      }
      // API-CORE-116: an account notice (JOBS-115) has no category switch. `true` is
      // the default, so the server drops it instead of storing it.
      if (ACCOUNT_NOTICES.has(k)) {
        if (!v) {
          res.status(400).json({ error: `categories.${k} cannot be turned off` });
          return;
        }
        continue;
      }
      out[k] = v;
    }
    patch.categories = out;
  }

  const result = await upsertPushPrefs(userId, patch);
  res.json(withoutAccountNotices(result));
});

/** API-CORE-116: GET and PUT never show a category key for an account notice. */
function withoutAccountNotices<P extends { categories: Record<string, boolean> }>(prefs: P): P {
  const categories = Object.fromEntries(
    Object.entries(prefs.categories).filter(([kind]) => !ACCOUNT_NOTICES.has(kind)),
  );
  return { ...prefs, categories };
}

export default router;
