import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const { mockGetSessionSignedInAt } = vi.hoisted(() => ({ mockGetSessionSignedInAt: vi.fn() }));
vi.mock('../db/queries/sessions.js', () => ({
  getSessionSignedInAt: (...a: unknown[]) => mockGetSessionSignedInAt(...a),
}));

import { requireRecentSignIn } from './recentSignIn.js';
import { CONFIG } from '../config.js';

function appWith(user: Record<string, unknown> | undefined) {
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user as never; next(); });
  app.post('/change', requireRecentSignIn, (_req, res) => { res.json({ ok: true }); });
  return app;
}

const user = { userId: 7, userUuid: 'u-7', email: 'a@test.com', isAdmin: false, sid: 'sid-a' };

describe('requireRecentSignIn [API-CLOUD-125]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('passes a session signed in a moment ago', async (ctx) => {
    story(ctx, 'Świeżo zalogowane urządzenie może zmienić sposób logowania.');
    mockGetSessionSignedInAt.mockResolvedValue(new Date(Date.now() - 60_000));
    const res = await request(appWith(user)).post('/change');
    expect(res.status).toBe(200);
    expect(mockGetSessionSignedInAt).toHaveBeenCalledWith(7, 'sid-a');
  });

  it('refuses a session signed in longer ago than the limit', async (ctx) => {
    story(ctx, 'Sesja sprzed ponad 10 minut musi się zalogować ponownie, zanim doda passkey albo hasło FTPS.');
    mockGetSessionSignedInAt.mockResolvedValue(new Date(Date.now() - (CONFIG.recentSignInMaxAgeSeconds + 5) * 1000));
    const res = await request(appWith(user)).post('/change');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Sign in again to change how you sign in', code: 'REAUTH_REQUIRED' });
  });

  it('refuses a token without a device session and a revoked session', async (ctx) => {
    story(ctx, 'Token bez sesji urządzenia (push, MCP) albo z odwołaną sesją nigdy nie zmieni sposobu logowania.');
    const { sid: _sid, ...noSid } = user;
    expect((await request(appWith(noSid)).post('/change')).status).toBe(403);
    expect(mockGetSessionSignedInAt).not.toHaveBeenCalled();
    mockGetSessionSignedInAt.mockResolvedValue(null);
    expect((await request(appWith(user)).post('/change')).status).toBe(403);
  });

  it('answers 503 when the lookup fails', async (ctx) => {
    story(ctx, 'Błąd bazy przy sprawdzaniu sesji nie przepuszcza zmiany.');
    mockGetSessionSignedInAt.mockRejectedValue(new Error('db down'));
    expect((await request(appWith(user)).post('/change')).status).toBe(503);
  });
});
