import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';

const { upsertPushDevice, upsertPushPrefs, getPushPrefs } = vi.hoisted(() => ({
  upsertPushDevice: vi.fn(() => Promise.resolve()),
  upsertPushPrefs: vi.fn(),
  getPushPrefs: vi.fn(),
}));

vi.mock('../db/queries/push.js', () => ({
  upsertPushDevice,
  upsertRelayPushDevice: vi.fn(),
  ownsRelayDevice: vi.fn(),
  deletePushDevice: vi.fn(),
  upsertPushPrefs,
  getPushPrefs,
}));

import accountRouter from './account.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 7, uuid: 'u', email: 'e', isAdmin: false, tokenGen: 3, sid: 'sid-a' } as any;
    next();
  });
  a.use('/api/v0/account', accountRouter);
  return a;
}

describe('POST /account/push-devices', () => {
  beforeEach(() => upsertPushDevice.mockClear());

  it('binds the registration to the caller\'s session and token generation', async (ctx) => {
    story(ctx, 'Rejestracja urządzenia push zapamiętuje sesję i generację tokenu, z których przyszła, żeby wylogowanie ucinało powiadomienia.');
    const res = await request(app()).post('/api/v0/account/push-devices').send({ token: 'tok', platform: 'ios' });
    expect(res.status).toBe(204);
    expect(upsertPushDevice).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, sessionId: 'sid-a', tokenGeneration: 3 }));
  });
});

describe('POST /account/push-devices platform', () => {
  beforeEach(() => upsertPushDevice.mockClear());

  it.each(['ios', 'android', 'macos'])('[API-CORE-078] accepts the platform %s', async (platform) => {
    const res = await request(app()).post('/api/v0/account/push-devices').send({ token: 'tok', platform });
    expect(res.status).toBe(204);
    expect(upsertPushDevice).toHaveBeenCalledWith(expect.objectContaining({ platform }));
  });

  it('[API-CORE-078] refuses another platform and names the three accepted ones', async () => {
    const res = await request(app()).post('/api/v0/account/push-devices').send({ token: 'tok', platform: 'windows' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "platform must be one of 'ios', 'android', 'macos'" });
    expect(upsertPushDevice).not.toHaveBeenCalled();
  });

  it('[API-CORE-080] refuses macos on the relay route, which keeps ios and android', async () => {
    process.env.KLIPGARD_PUSH_RELAY_URL = 'https://relay.example.test';
    try {
      const res = await request(app()).post('/api/v0/account/push-devices/relay').send({ platform: 'macos', publicKey: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "platform must be one of 'ios', 'android'" });
    } finally {
      delete process.env.KLIPGARD_PUSH_RELAY_URL;
    }
  });
});

describe('push-prefs and the account notices', () => {
  beforeEach(() => {
    upsertPushPrefs.mockReset();
    getPushPrefs.mockReset();
    upsertPushPrefs.mockImplementation(async (_u: number, patch: { categories?: Record<string, boolean> }) => ({
      snoozeUntil: null, categories: patch.categories ?? {},
    }));
  });

  it.each(['user_banned', 'content_deletion_scheduled', 'content_deleted'])(
    '[API-CORE-116] refuses categories.%s = false with 400 and stores nothing',
    async (kind) => {
      const res = await request(app()).put('/api/v0/account/push-prefs').send({ categories: { new_recording: false, [kind]: false } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: `categories.${kind} cannot be turned off` });
      expect(upsertPushPrefs).not.toHaveBeenCalled();
    },
  );

  it('[API-CORE-116] accepts true for an account notice but does not store it', async () => {
    const res = await request(app()).put('/api/v0/account/push-prefs').send({ categories: { new_recording: false, user_banned: true } });
    expect(res.status).toBe(200);
    expect(upsertPushPrefs).toHaveBeenCalledWith(7, { categories: { new_recording: false } });
    expect(res.body.categories).toEqual({ new_recording: false });
  });

  it('[API-CORE-116] hides a stale account-notice key in both answers, so an app that echoes the map is never refused', async () => {
    getPushPrefs.mockResolvedValue({ snoozeUntil: null, categories: { new_recording: false, user_banned: false } });
    const res = await request(app()).get('/api/v0/account/push-prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ snoozeUntil: null, categories: { new_recording: false } });
  });

  it('[API-CORE-082] still replaces the map for the other kinds', async () => {
    const res = await request(app()).put('/api/v0/account/push-prefs').send({ categories: { duplicate_file: false } });
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual({ duplicate_file: false });
  });
});
