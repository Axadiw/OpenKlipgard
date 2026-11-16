import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const { mockVerifyToken, mockGetTokenGeneration, mockGetSessionAuthState, mockIsMcpFamilyActive } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockGetTokenGeneration: vi.fn(),
  mockGetSessionAuthState: vi.fn(),
  mockIsMcpFamilyActive: vi.fn(),
}));

vi.mock('../services/auth.js', () => ({
  verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
}));
vi.mock('../db/queries/users.js', () => ({
  getTokenGeneration: (...a: unknown[]) => mockGetTokenGeneration(...a),
}));
vi.mock('../db/queries/sessions.js', () => ({
  getSessionAuthState: (...a: unknown[]) => mockGetSessionAuthState(...a),
}));
vi.mock('../db/queries/oauth.js', () => ({
  isMcpFamilyActive: (...a: unknown[]) => mockIsMcpFamilyActive(...a),
}));

import { requireAuth, requireMediaAuth, requireScopedMediaAuth } from './auth.js';

function createApp() {
  const app = express();
  app.get('/probe', requireAuth, (req, res) => { res.json({ userId: req.user!.userId }); });
  return app;
}

const base = { userId: 7, userUuid: 'u-7', email: 'a@test.com', isAdmin: false, kind: 'access' };

describe('requireAuth', () => {
  let app: express.Express;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('lets a token through while its device session stands', async (ctx) => {
    story(ctx, 'Token zalogowanego urządzenia działa, dopóki jego sesja trwa i konto nie zostało wylogowane wszędzie.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: true });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(mockGetSessionAuthState).toHaveBeenCalledWith(7, 'sid-a');
    expect(mockGetTokenGeneration).not.toHaveBeenCalled();
  });

  it('refuses a token whose device was signed out, before it expires', async (ctx) => {
    story(ctx, 'Po wylogowaniu urządzenia jego access token przestaje działać od razu, a nie dopiero po 15 minutach.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: false });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token revoked');
  });

  it('refuses a device-bound token after a sign-out everywhere', async (ctx) => {
    story(ctx, '„Wyloguj wszędzie” (albo zmiana hasła) kończy także sesje urządzeń, których wiersze nadal istnieją.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 4, sessionActive: true });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
  });

  it('checks only the generation for a token issued before device sessions', async (ctx) => {
    story(ctx, 'Tokeny sprzed wdrożenia sesji urządzeń działają dalej — nikt nie zostaje wylogowany przez samo wdrożenie.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3 });
    mockGetTokenGeneration.mockResolvedValue(3);

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(mockGetSessionAuthState).not.toHaveBeenCalled();
  });

  it('never accepts a refresh token as a bearer', async (ctx) => {
    story(ctx, 'Refresh token wysłany jako Bearer jest odrzucany — nawet gdy jego sesja trwa.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'refresh', tokenGen: 3, sid: 'sid-a' });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
    expect(mockGetSessionAuthState).not.toHaveBeenCalled();
  });
});

function createMediaApp() {
  const app = express();
  const r = express.Router();
  const ok: express.RequestHandler = (_req, res) => { res.json({ ok: true }); };
  r.get('/:id/thumbnail', ok);
  r.get('/:id/video/:view', ok);
  r.head('/:id/video/:view', ok);
  r.get('/:id/video/:view/original', ok);
  r.get('/:id/video/:view/frames', ok);
  r.get('/:id/detail', ok);
  r.delete('/:id', ok);
  r.post('/:id/media-token', ok);
  app.use('/api/v0/events', requireMediaAuth, r);
  return app;
}

const media = { ...base, kind: 'media', mediaEventId: 'E' };

describe('media tokens', () => {
  let app: express.Express;
  let mediaApp: express.Express;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mediaApp = createMediaApp();
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: true });
    mockGetTokenGeneration.mockResolvedValue(3);
    mockIsMcpFamilyActive.mockResolvedValue(true);
  });

  it('refuses a media token as a bearer on a general route', async (ctx) => {
    story(ctx, 'Token do podglądu jednego nagrania nie otwiera zwykłych endpointów API, ani w nagłówku, ani w adresie URL.');
    mockVerifyToken.mockReturnValue({ ...media, tokenGen: 3, sid: 's' });

    const a = await request(app).get('/probe').set('Authorization', 'Bearer t');
    const b = await request(app).get('/probe?media_token=t');

    expect(a.status).toBe(401);
    expect(a.body.error).toBe('Wrong token kind');
    expect(b.status).toBe(401);
  });

  it('refuses a token that carries mediaEventId even without kind', async (ctx) => {
    story(ctx, 'Token z identyfikatorem nagrania, ale bez oznaczenia rodzaju, też nie jest tokenem dostępu.');
    mockVerifyToken.mockReturnValue({ ...base, kind: undefined, mediaEventId: 'E', tokenGen: 3, sid: 's' });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
  });

  it('media token works only on the media GET/HEAD routes', async (ctx) => {
    story(ctx, 'Token nagrania działa tylko na miniaturze i wideo (GET/HEAD), a nie na ramkach, szczegółach, usuwaniu ani wystawianiu tokenów.');
    mockVerifyToken.mockReturnValue({ ...media, tokenGen: 3, sid: 's' });
    const get = (u: string) => request(mediaApp).get(u).set('Authorization', 'Bearer t');

    expect((await get('/api/v0/events/E/thumbnail')).status).toBe(200);
    expect((await get('/api/v0/events/E/video/v')).status).toBe(200);
    expect((await request(mediaApp).head('/api/v0/events/E/video/v').set('Authorization', 'Bearer t')).status).toBe(200);
    expect((await get('/api/v0/events/E/video/v/original')).status).toBe(200);
    expect((await get('/api/v0/events/E/detail')).status).toBe(401);
    expect((await get('/api/v0/events/E/video/v/frames')).status).toBe(401);
    expect((await request(mediaApp).delete('/api/v0/events/E').set('Authorization', 'Bearer t')).status).toBe(401);
    expect((await request(mediaApp).post('/api/v0/events/E/media-token').set('Authorization', 'Bearer t')).status).toBe(401);
  });

  it('media token dies with its device session', async (ctx) => {
    story(ctx, 'Po wylogowaniu urządzenia wydany mu token nagrania przestaje działać od razu.');
    mockVerifyToken.mockReturnValue({ ...media, tokenGen: 3, sid: 's' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: false });

    const res = await request(mediaApp).get('/api/v0/events/E/thumbnail').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
  });

  it('push-minted media token (no sid) dies after sign-out everywhere', async (ctx) => {
    story(ctx, 'Token z powiadomienia push (bez sesji) przestaje działać po „wyloguj wszędzie”.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'media', mediaEventId: 'E', tokenGen: 3 });
    mockGetTokenGeneration.mockResolvedValue(4);

    const res = await request(mediaApp).get('/api/v0/events/E/thumbnail').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
  });

  it('[MCP-082] MCP media token needs both a live family and the current generation', async (ctx) => {
    story(ctx, 'Token nagrania wydany przez MCP działa tylko, gdy zgoda MCP trwa i konto nie zostało wylogowane wszędzie.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'media', mediaEventId: 'E', tokenGen: 3, mcpFamilyId: 'fam' });
    const go = () => request(mediaApp).get('/api/v0/events/E/video/v').set('Authorization', 'Bearer t');

    mockIsMcpFamilyActive.mockResolvedValue(false);
    expect((await go()).status).toBe(401);

    mockIsMcpFamilyActive.mockResolvedValue(true);
    mockGetTokenGeneration.mockResolvedValue(4);
    expect((await go()).status).toBe(401);

    mockGetTokenGeneration.mockResolvedValue(3);
    expect((await go()).status).toBe(200);
  });

  it('access token still works on the events mount', async (ctx) => {
    story(ctx, 'Zwykły token dostępu nadal działa na wszystkich endpointach nagrań.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'access', tokenGen: 3, sid: 's' });

    const res = await request(mediaApp).get('/api/v0/events/E/detail').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
  });
});

describe('scoped media tokens ([API-CORE-043], [API-CLOUD-284])', () => {
  const scoped = { ...base, kind: 'media', mediaScope: 'changelog', tokenGen: 3, sid: 's' };
  const scope = {
    name: 'changelog',
    allowed: (req: express.Request) => (req.method === 'GET' || req.method === 'HEAD') && /^\/shots\/[^/]+$/.test(req.path),
  };
  let app: express.Express;
  let mediaApp: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: true });
    mockGetTokenGeneration.mockResolvedValue(3);
    app = express();
    const r = express.Router();
    const ok: express.RequestHandler = (_req, res) => { res.json({ ok: true }); };
    r.get('/shots/:name', ok);
    r.get('/', ok);
    r.post('/media-token', ok);
    app.use('/api/v0/admin/changelog', requireScopedMediaAuth(scope), r);
    mediaApp = createMediaApp();
  });

  it('opens only the allowed route for its own scope', async (ctx) => {
    story(ctx, 'Token do zrzutów changelogu działa na zrzucie (GET/HEAD), ale nie na treści changelogu ani na wystawianiu kolejnych tokenów.');
    mockVerifyToken.mockReturnValue(scoped);
    const go = (u: string) => request(app).get(u).set('Authorization', 'Bearer t');

    expect((await go('/api/v0/admin/changelog/shots/a.png')).status).toBe(200);
    expect((await request(app).get('/api/v0/admin/changelog/shots/a.png?media_token=t')).status).toBe(200);
    expect((await request(app).head('/api/v0/admin/changelog/shots/a.png').set('Authorization', 'Bearer t')).status).toBe(200);
    expect((await go('/api/v0/admin/changelog/')).status).toBe(401);
    const mint = await request(app).post('/api/v0/admin/changelog/media-token').set('Authorization', 'Bearer t');
    expect(mint.status).toBe(401);
    expect(mint.body.error).toBe('Wrong token kind');
  });

  it('is refused by the general guard and by the event media guard', async (ctx) => {
    story(ctx, 'Token zrzutów changelogu nie otwiera zwykłych endpointów ani miniatur i wideo nagrań — bez identyfikatora zdarzenia nie może udawać tokenu nagrania.');
    mockVerifyToken.mockReturnValue(scoped);

    expect((await request(createApp()).get('/probe').set('Authorization', 'Bearer t')).status).toBe(401);
    expect((await request(mediaApp).get('/api/v0/events/E/thumbnail').set('Authorization', 'Bearer t')).status).toBe(401);
    expect((await request(mediaApp).get('/api/v0/events/E/video/v').set('Authorization', 'Bearer t')).status).toBe(401);
  });

  it('refuses a scope other than the guard scope, and an event media token', async (ctx) => {
    story(ctx, 'Strażnik zrzutów changelogu nie przyjmie tokenu innego zakresu ani tokenu nagrania.');
    const go = () => request(app).get('/api/v0/admin/changelog/shots/a.png').set('Authorization', 'Bearer t');

    mockVerifyToken.mockReturnValue({ ...scoped, mediaScope: 'other' });
    expect((await go()).status).toBe(401);
    mockVerifyToken.mockReturnValue({ ...base, kind: 'media', mediaEventId: 'E', tokenGen: 3, sid: 's' });
    expect((await go()).status).toBe(401);
  });

  it('accepts an access token on the whole mount and ends with the device session', async (ctx) => {
    story(ctx, 'Zwykły token dostępu nadal działa na całym changelogu, a token zrzutów umiera razem z sesją urządzenia.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'access', tokenGen: 3, sid: 's' });
    expect((await request(app).post('/api/v0/admin/changelog/media-token').set('Authorization', 'Bearer t')).status).toBe(200);

    mockVerifyToken.mockReturnValue(scoped);
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: false });
    expect((await request(app).get('/api/v0/admin/changelog/shots/a.png').set('Authorization', 'Bearer t')).status).toBe(401);
  });
});
