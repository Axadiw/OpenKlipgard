import { Router } from 'express';
import {
  getUserByEmail,
  getUserByInternalId,
  getTokenGeneration,
  bumpTokenGeneration,
  countUnusedBackupCodes,
  getFtpsState,
} from '../db/queries/users.js';
import { isUserLocked, isUserBanned, recordFailedLogin, resetLoginAttempts } from '../db/queries/lockout.js';
import {
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  DUMMY_HASH,
} from '../services/auth.js';
import { loginRateLimit, loginEmailRateLimit, refreshTokenRateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { auditLog } from '../services/audit.js';
import { issueSessionTokens } from '../services/sessions.js';
import { createSession, rotateRefreshSession, revokeSession } from '../db/queries/sessions.js';
import { normalizeEmail } from '../utils/normalizeEmail.js';
import { signInRefusal, editionHooks } from '../hooks.js';

// Core authentication: password login, token refresh and sign-out. Password
// change, the separate FTPS credential, email-driven flows (verification,
// reset, account-deletion confirmation), passkeys and OAuth identity management
// are cloud-only and live in server/cloud/routes/auth.ts, mounted at the same
// /api/v0/auth prefix by the cloud edition.

const router = Router();

router.post('/login', loginRateLimit, loginEmailRateLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const user = await getUserByEmail(email);

    // The web channel's lockout only (a camera retrying an outdated password
    // locks the FTP logins, never this sign-in), and only for this caller's
    // address (or, past the account-wide backstop, an address the account
    // has not signed in from).
    const lockStatus = user
      ? await isUserLocked(user.internalId, 'web', req.ip ?? null)
      : { locked: false as const, lockedUntil: null };

    // Always run bcrypt.compare to prevent timing-based user enumeration
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      // [API-CORE-052] A wrong password gets the same 401 whether or not the
      // sign-in is locked, so the lockout is not readable from the address alone.
      // A locked sign-in counts no more failures: they would stretch the streak.
      if (user && !lockStatus.locked) await recordFailedLogin(user.internalId, 'web', req.ip ?? null);
      auditLog('LOGIN_FAILURE', { email, ip: req.ip });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // [API-CORE-053] The lockout answer, like the ban answer below, is for
    // whoever proved the password.
    if (lockStatus.locked) {
      const retryAfter = Math.ceil((new Date(lockStatus.lockedUntil!).getTime() - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      auditLog('LOGIN_LOCKED', { email, ip: req.ip, lockedUntil: lockStatus.lockedUntil });
      res.status(423).json({ error: 'Account temporarily locked. Try again later.', retryAfter });
      return;
    }
    // The ban answer (reason, until) is for whoever proved the password, never
    // for a caller who only knows the address: a wrong password gets the 401
    // above, so this is not a way to read an account's moderation state.
    const banStatus = await isUserBanned(user.internalId);
    if (banStatus.banned) {
      auditLog('LOGIN_BANNED', { email, ip: req.ip, until: banStatus.until });
      res.status(403).json({
        error: 'Account suspended',
        banned: true,
        until: banStatus.indefinite ? null : banStatus.until,
        reason: banStatus.reason ?? null,
        indefinite: !!banStatus.indefinite,
      });
      return;
    }
    // The edition's own rule (Klipgard Cloud: the e-mail address must be
    // confirmed — 403 EMAIL_NOT_VERIFIED). Only after the password was proven,
    // so a wrong password never learns it, and before the `active` check, so
    // an inactive, unconfirmed account is told to confirm its address first.
    const refusal = signInRefusal(user);
    if (refusal) {
      auditLog('LOGIN_REFUSED', { email, ip: req.ip, code: refusal.body.code });
      res.status(refusal.status).json(refusal.body);
      return;
    }
    // Treat inactive accounts the same as invalid credentials to prevent user enumeration:
    // a 403 "pending activation" response would confirm both email existence and correct password.
    if (!user.active) {
      await recordFailedLogin(user.internalId, 'web', req.ip ?? null);
      auditLog('LOGIN_FAILURE', { email, ip: req.ip });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Passkey-enabled accounts MUST authenticate via /auth/login/passkey;
    // refuse the password path so a stolen password is useless on its own.
    const ftpsState = await getFtpsState(user.internalId);
    if (ftpsState?.passkeyEnabled) {
      auditLog('LOGIN_PASSKEY_REQUIRED', { email: user.email, userId: user.id, ip: req.ip });
      // The password is proven here, so naming the account's credentials in a
      // ready challenge reveals nothing new, and a client that never asks
      // /login/start can start the ceremony at once. A failing
      // hook leaves the plain 400.
      let challenge: { sessionId: string; options: unknown } | null = null;
      try {
        challenge = (await editionHooks().passkeyChallenge?.(user.internalId)) ?? null;
      } catch (err) {
        console.error('Passkey challenge error:', err instanceof Error ? err.message : 'Unknown error');
      }
      res.status(400).json({
        error: 'Use passkey to sign in',
        passkeyRequired: true,
        ...(challenge ? { sessionId: challenge.sessionId, options: challenge.options } : {}),
      });
      return;
    }

    await resetLoginAttempts(user.internalId, 'web', req.ip ?? null);
    auditLog('LOGIN_SUCCESS', { email: user.email, userId: user.id, ip: req.ip });

    // Refund the rate-limit point on success. Brute-force protection only
    // needs to count FAILED attempts — a legitimate password-manager
    // workflow (typo + correct, or multi-account session) would otherwise
    // burn the per-IP budget twice as fast as the cap suggests. Failure
    // paths above (invalid credentials, banned, locked, passkey-required)
    // intentionally do NOT refund.
    await req.refundRateLimit?.();

    const basePayload = {
      userId: user.internalId,
      userUuid: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: user.tokenGeneration,
    };
    const { token, refreshToken } = await issueSessionTokens(basePayload);

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        isAdmin: user.isAdmin,
        active: user.active,
      },
    });
  } catch (err) {
    console.error('Login error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Exchange a refresh token for a new access+refresh pair. Rate-limited under
// its own budget — sharing /auth/login's budget caused login flak from the
// same egress IP (CGNAT, office NAT) to knock out healthy sessions' silent
// refresh. The token-stuffing risk is bounded by the refresh-token signature
// check below; the IP cap is just a backstop. Refresh tokens must be
// kind='refresh'; an access token here is rejected so a stolen access token
// cannot extend a session.
router.post('/refresh', refreshTokenRateLimit, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    if (payload.kind !== 'refresh') {
      res.status(401).json({ error: 'Wrong token kind' });
      return;
    }

    const user = await getUserByInternalId(payload.userId);
    if (!user || !user.active) {
      res.status(401).json({ error: 'Account unavailable' });
      return;
    }

    // The same edition rule as /login: a session that predates it (or an
    // address that was un-confirmed since) cannot be kept alive.
    // Answered as 401 here (with the same body and code): the native apps end
    // a session only on a 401 from refresh, and would otherwise sit in a dead
    // signed-in state instead of returning to the sign-in screen.
    const refusal = signInRefusal(user);
    if (refusal) {
      res.status(401).json(refusal.body);
      return;
    }

    const banStatus = await isUserBanned(user.internalId);
    if (banStatus.banned) {
      res.status(403).json({
        error: 'Account suspended',
        banned: true,
        until: banStatus.indefinite ? null : banStatus.until,
        reason: banStatus.reason ?? null,
        indefinite: !!banStatus.indefinite,
      });
      return;
    }

    const currentGen = await getTokenGeneration(user.internalId);
    if (payload.tokenGen !== currentGen) {
      res.status(401).json({ error: 'Refresh token revoked' });
      return;
    }

    // The refresh keeps the device's session. A token from before per-device
    // sessions has none and gets one here, so it can be signed out on its own
    // from now on.
    // [API-CORE-063] A replaced refresh token presented again is a repeat inside
    // the grace window and a probable theft outside it: the session ends.
    let sid: string;
    let seq: number;
    if (payload.sid) {
      const rotation = await rotateRefreshSession(payload.sid, user.internalId, payload.rseq ?? 0);
      if (rotation.kind === 'reused') {
        auditLog('TOKEN_REUSE', { userId: user.id, email: user.email, ip: req.ip });
      }
      if (rotation.kind === 'reused' || rotation.kind === 'gone') {
        res.status(401).json({ error: 'Refresh token revoked' });
        return;
      }
      sid = payload.sid;
      seq = rotation.seq;
    } else {
      sid = await createSession(user.internalId);
      seq = 0;
    }

    const basePayload = {
      userId: user.internalId,
      userUuid: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenGen: currentGen,
      sid,
    };
    const token = generateAccessToken(basePayload);
    const newRefreshToken = generateRefreshToken({ ...basePayload, rseq: seq });

    auditLog('TOKEN_REFRESH', { userId: user.id, email: user.email, ip: req.ip });
    res.json({ token, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('Refresh error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// POST /logout — server-side sign-out.
//   { "scope": "device" } ends only the session of the token that made the
//   request; the user's other devices stay signed in.
//   { "scope": "all" }, or no scope, bumps token_generation and ends every
//   session (and MCP grant) at once — consistent with password change and
//   passkey removal. No scope stays "all" because that is what the endpoint
//   did before scopes existed.
// A token from before per-device sessions has no session to end, so "device"
// falls back to "all" for it: the sign-out must actually end the session. The
// answer says which one happened.
router.post('/logout', requireAuth, async (req, res) => {
  const requested = req.body?.scope;
  if (requested !== undefined && requested !== 'device' && requested !== 'all') {
    res.status(400).json({ error: 'scope must be "device" or "all"' });
    return;
  }
  try {
    const sid = req.user!.sid;
    const scope = requested === 'device' && sid ? 'device' : 'all';
    if (scope === 'device') {
      await revokeSession(sid!, req.user!.userId);
    } else {
      await bumpTokenGeneration(req.user!.userId);
    }
    auditLog('LOGOUT', { userId: req.user!.userUuid, scope, ip: req.ip });
    res.json({ success: true, scope });
  } catch (err) {
    console.error('Logout error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/passkey-state', requireAuth, async (req, res) => {
  try {
    const [ftps, user] = await Promise.all([
      getFtpsState(req.user!.userId),
      getUserByInternalId(req.user!.userId),
    ]);
    const unused = ftps?.passkeyEnabled ? await countUnusedBackupCodes(req.user!.userId) : 0;
    res.json({
      passkeyEnabled: !!ftps?.passkeyEnabled,
      hasFtpsPassword: !!ftps?.hasFtpsPassword,
      hasPasswordLogin: user?.passwordHash !== null && user?.passwordHash !== undefined,
      unusedBackupCodes: unused,
    });
  } catch (err) {
    console.error('Passkey state error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to load passkey state' });
  }
});

export default router;
