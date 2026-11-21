import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import { getTokenGeneration } from '../db/queries/users.js';
import { isMcpFamilyActive } from '../db/queries/oauth.js';
import { getSessionAuthState } from '../db/queries/sessions.js';

type JwtPayload = ReturnType<typeof verifyToken>;

/**
 * True while the token's grant still stands. Device-bound tokens need their
 * session AND the current generation; tokens without a sid (push-minted, MCP,
 * pre-session) need the generation; MCP tokens also need their OAuth family.
 */
async function checkRevocation(p: JwtPayload): Promise<boolean> {
  if (p.tokenGen != null) {
    if (p.sid) {
      const state = await getSessionAuthState(p.userId, p.sid);
      if (state.tokenGeneration !== p.tokenGen || !state.sessionActive) return false;
    } else if ((await getTokenGeneration(p.userId)) !== p.tokenGen) {
      return false;
    }
  }
  // MCP-issued media tokens are bound to the OAuth grant's refresh-token
  // family: reject at once when it is revoked instead of waiting out the TTL.
  if (p.mcpFamilyId && !(await isMcpFamilyActive(p.mcpFamilyId))) return false;
  return true;
}

interface MediaScope {
  /** The `mediaScope` claim this guard serves. */
  name: string;
  /** True for the requests (relative to the mount) a token of that scope may carry. */
  allowed: (req: Request) => boolean;
}

const SESSION_KINDS = new Set(['access', 'refresh', 'media']);

/** A token the server issues for a session: a known kind (missing = access),
 *  a positive integer account id and a UUID string. */
export function isSessionTokenShape(p: unknown): p is JwtPayload {
  if (!p || typeof p !== 'object') return false;
  const t = p as Record<string, unknown>;
  if (t.kind !== undefined && !SESSION_KINDS.has(t.kind as string)) return false;
  return Number.isInteger(t.userId) && (t.userId as number) > 0
    && typeof t.userUuid === 'string' && t.userUuid.length > 0;
}

function authenticate(req: Request, res: Response, next: NextFunction, allowMedia: boolean, scope?: MediaScope): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // Refresh tokens may only be sent to /auth/refresh — never as a Bearer on
  // any other route. A stolen access token that leaked should NOT get a way
  // to refresh itself just because it was presented here.
  // Only session tokens of a real account are credentials here [API-CORE-040].
  // Any other kind signed with the same secret (and any token without a numeric
  // account id and UUID) is refused, so a token minted for another purpose can
  // never stand in for a session and reach a query with an undefined owner.
  if (!isSessionTokenShape(payload)) {
    res.status(401).json({ error: 'Wrong token kind' });
    return;
  }
  const isMedia = payload.kind === 'media' || !!payload.mediaEventId || !!payload.mediaScope;
  // A scoped media token passes only the guard of its own scope, on the
  // requests that guard allows; an event media token never passes a scoped guard.
  const mediaAllowed = payload.mediaScope
    ? !!scope && scope.name === payload.mediaScope && scope.allowed(req)
    : allowMedia && mediaRouteAllowed(req);
  if (payload.kind === 'refresh' || (isMedia && !mediaAllowed)) {
    res.status(401).json({ error: 'Wrong token kind' });
    return;
  }
  checkRevocation(payload).then(ok => {
    if (!ok) {
      res.status(401).json({ error: 'Token revoked' });
      return;
    }
    req.user = payload;
    next();
  }).catch(() => {
    res.status(401).json({ error: 'Authentication error' });
  });
}

// Path relative to the /api/v0/events mount. `/frames` is deliberately absent:
// every client calls it with the access token.
const MEDIA_PATH = /^\/([^/]+)\/(thumbnail|video\/[^/]+(\/original)?)$/;

function mediaRouteAllowed(req: Request): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && MEDIA_PATH.test(req.path);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  authenticate(req, res, next, false);
}

/**
 * For the /api/v0/events mount only: like requireAuth, but also accepts a
 * short-lived media token on the thumbnail / video GET+HEAD routes it exists
 * for. A media token is refused everywhere else.
 */
export function requireMediaAuth(req: Request, res: Response, next: NextFunction): void {
  authenticate(req, res, next, true);
}

/**
 * Like requireAuth, but also accepts the scoped media token of `scope` on the
 * requests `scope.allowed` names. Used by routes that an `<img>` tag loads,
 * which cannot send an authorization header.
 */
export function requireScopedMediaAuth(scope: MediaScope) {
  return (req: Request, res: Response, next: NextFunction): void => authenticate(req, res, next, false, scope);
}

function extractToken(req: Request): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Fall back to short-lived media token query parameter (for <video>/<img> tags)
  const mediaToken = req.query.media_token;
  if (typeof mediaToken === 'string' && mediaToken.length > 0) {
    return mediaToken;
  }
  return null;
}
