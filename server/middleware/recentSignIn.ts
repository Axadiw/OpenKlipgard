import type { Request, Response, NextFunction } from 'express';
import { CONFIG } from '../config.js';
import { getSessionSignedInAt } from '../db/queries/sessions.js';

/**
 * Gate for changes of how the account signs in [API-CLOUD-125]. Runs after
 * requireAuth. The request MUST come from a device session (a `sid` claim)
 * that was signed in at most `CONFIG.recentSignInMaxAgeSeconds` ago. A token
 * without a session (push-minted, MCP) never passes. Refresh does not renew
 * the sign-in time, so a stolen token of an older session cannot add a
 * passkey or an FTPS password and lock the owner out.
 */
export async function isRecentSignIn(req: Request): Promise<boolean> {
  const user = req.user;
  if (!user?.sid) return false;
  const signedInAt = await getSessionSignedInAt(user.userId, user.sid);
  return !!signedInAt && Date.now() - signedInAt.getTime() <= CONFIG.recentSignInMaxAgeSeconds * 1000;
}

export function sendReauthRequired(res: Response): void {
  res.status(403).json({ error: 'Sign in again to change how you sign in', code: 'REAUTH_REQUIRED' });
}

export function requireRecentSignIn(req: Request, res: Response, next: NextFunction): void {
  isRecentSignIn(req).then(ok => {
    if (!ok) { sendReauthRequired(res); return; }
    next();
  }).catch(() => {
    res.status(503).json({ error: 'Authentication error' });
  });
}
