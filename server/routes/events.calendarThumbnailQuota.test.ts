import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import type { CameraEvent, JwtPayload } from '../types.js';
import { story } from '../testing/story.js';

// Rule tests for API-EVENTS-044 (calendar dates) and API-EVENTS-056 (thumbnail
// transfer bands). Mocks as in events.security.test.ts, trimmed to what these
// two routes touch.
vi.mock('../db/queries/events.js', () => ({
  getEvents: vi.fn(),
  getEventByIdForOwner: vi.fn(),
  getCameraNames: vi.fn(() => Promise.resolve([])),
  getCameraDetails: vi.fn(() => Promise.resolve([])),
  getEventCalendar: vi.fn(() => Promise.resolve([])),
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
  getFileMetadataByKey: vi.fn(),
  getPlaybackPatchState: vi.fn(),
  deleteEvent: vi.fn(),
  getFileMetadataSize: vi.fn(),
  removeFileMetadata: vi.fn(),
}));

vi.mock('../db/queries/storage.js', () => ({
  updateTransferUsage: vi.fn(() => Promise.resolve()),
  checkAndResetTransfer: vi.fn(() => Promise.resolve({ transferUsageBytes: 0 })),
  getUserQuota: vi.fn(() => Promise.resolve(null)),
  updateDiskUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../db/queries/access.js', () => ({
  isAccessLocked: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../db/queries/users.js', () => ({
  getUserByInternalId: vi.fn(),
}));

vi.mock('../services/sidecarCache.js', () => ({
  getSidecar: vi.fn(),
  invalidateSidecar: vi.fn(),
}));

vi.mock('../services/s3.js', () => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
  cachedHeadObject: vi.fn(),
  deleteObject: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/auth.js', () => ({
  generateMediaToken: vi.fn(() => 'mock-media-token'),
}));

vi.mock('../services/cameraProfileResolver.js', () => ({
  enrichEventsWithViewMeta: vi.fn((events: unknown[]) => Promise.resolve(events)),
  enrichEventWithViewMeta: vi.fn((event: unknown) => Promise.resolve(event)),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  mediaRateLimit: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  apiRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  diskInfoRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Spy on the pacing stream while keeping the real implementation.
vi.mock('../services/quota-throttle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/quota-throttle.js')>();
  return { ...actual, buildThrottleStream: vi.fn(actual.buildThrottleStream) };
});

vi.mock('../config.js', () => ({
  CONFIG: {
    itemsPerPage: 50,
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
    mediaTokenExpirySeconds: 900,
    cleanFrameEnabled: true,
  },
}));

import eventsRouter from './events.js';
import { getEventByIdForOwner, getEventCalendar } from '../db/queries/events.js';
import { getUserByInternalId } from '../db/queries/users.js';
import { getObject, headObject } from '../services/s3.js';
import { checkAndResetTransfer, getUserQuota } from '../db/queries/storage.js';
import { buildThrottleStream } from '../services/quota-throttle.js';

const USER_A: JwtPayload = { userId: 1, userUuid: 'uuid-aaa-111', email: 'alice@test.com', isAdmin: false };

const EVENT: CameraEvent = {
  id: 'evt-001',
  camera: 'cam1',
  timestamp: '2025-12-01T10:00:00Z',
  date: '2025-12-01',
  views: [{ id: '00', videoRelPath: 'cam1/2025-12-01/wide.mp4' }],
  thumbnail: '__s3_thumb__/uuid-aaa-111/evt-001.jpg',
  duration: 30,
  ownerId: USER_A.userId,
};

function buildApp() {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { ...USER_A };
    next();
  });
  app.use('/events', eventsRouter);
  return app;
}

const LIMIT = 1_000_000;
const THUMB_BYTES = 11;

function quotaWithUsage(usage: number): void {
  vi.mocked(checkAndResetTransfer).mockResolvedValue({ transferUsageBytes: usage } as never);
  vi.mocked(getUserQuota).mockResolvedValue({ transferLimitBytes: LIMIT } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT);
  vi.mocked(headObject).mockResolvedValue({ contentLength: THUMB_BYTES, lastModified: new Date() } as never);
  vi.mocked(getObject).mockImplementation((async () => ({
    body: Readable.from([Buffer.from('thumb-bytes')]),
    contentRange: undefined,
  })) as never);
  vi.mocked(getUserByInternalId).mockResolvedValue({
    id: USER_A.userUuid, email: USER_A.email, isAdmin: false, active: true, createdAt: '2025-01-01',
    internalId: USER_A.userId, passwordHash: 'hash', tokenGeneration: 1, encryptionSalt: 'salt-aaa',
  } as never);
});

describe('GET /events/calendar — API-EVENTS-044 date validation before the window cap', () => {
  it('[API-EVENTS-044] rejects a month that does not exist with 400, not a silent pass', async (ctx) => {
    story(ctx, 'Data typu 2026-13-01 pasuje do wzorca, ale nie jest datą z kalendarza. Dostaje 400, zamiast omijać limit 366 dni.');
    const res = await request(buildApp()).get('/events/calendar?from=2026-13-01&to=2026-14-01');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'from and to must be YYYY-MM-DD dates' });
    expect(getEventCalendar).not.toHaveBeenCalled();
  });

  it('[API-EVENTS-044] an invalid `from` cannot hide a window of years', async (ctx) => {
    story(ctx, 'Zła data początkowa przy bardzo odległej dacie końcowej nie może zrobić z zapytania nieograniczonego zakresu.');
    const res = await request(buildApp()).get('/events/calendar?from=2026-13-01&to=2099-12-31');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from and to must be YYYY-MM-DD dates');
    expect(getEventCalendar).not.toHaveBeenCalled();
  });

  it.each([['2026-02-30'], ['2026-00-10'], ['2026-04-31'], ['2025-02-29']])(
    '[API-EVENTS-044] rejects the impossible day %s',
    async (bad) => {
      const res = await request(buildApp()).get(`/events/calendar?from=${bad}&to=2026-12-31`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('from and to must be YYYY-MM-DD dates');
    },
  );

  it('[API-EVENTS-044] accepts a real leap day and still caps the window at 366 days', async (ctx) => {
    story(ctx, 'Prawdziwa data 29 lutego roku przestępnego przechodzi, a zakres dłuższy niż 366 dni nadal jest odrzucany.');
    const ok = await request(buildApp()).get('/events/calendar?from=2024-02-29&to=2024-03-01');
    expect(ok.status).toBe(200);
    expect(getEventCalendar).toHaveBeenCalledWith(USER_A.userId, '2024-02-29', '2024-03-01');

    const wide = await request(buildApp()).get('/events/calendar?from=2024-01-01&to=2025-01-02');
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe('window must not exceed 366 days');
  });
});

describe('GET /events/:id/thumbnail — API-EVENTS-056 shares the transfer bands of API-EVENTS-065', () => {
  it('[API-EVENTS-056] serves at full speed below 90 % of the limit', async (ctx) => {
    story(ctx, 'Poniżej 90 % limitu transferu miniatura jest wysyłana normalnie, bez spowolnienia.');
    quotaWithUsage(0.5 * LIMIT);
    const res = await request(buildApp()).get('/events/evt-001/thumbnail');
    expect(res.status).toBe(200);
    expect(buildThrottleStream).not.toHaveBeenCalled();
  });

  it('[API-EVENTS-056] still serves, at 512 KiB/s, between 90 % and 120 % of the limit', async (ctx) => {
    story(ctx, 'Przy zużyciu limitu transferu między 90 % a 120 % miniatura nie jest odrzucana, tylko wysyłana wolniej, tak jak wideo. Wcześniej dostawała 429 już przy 100 %.');
    for (const usage of [0.95 * LIMIT, 1.0 * LIMIT, 1.1 * LIMIT]) {
      vi.mocked(buildThrottleStream).mockClear();
      quotaWithUsage(usage);
      const res = await request(buildApp()).get('/events/evt-001/thumbnail');
      expect(res.status).toBe(200);
      expect(buildThrottleStream).toHaveBeenCalledWith(512 * 1024);
    }
  });

  it('[API-EVENTS-056] answers 429 from 120 % of the limit and reads no object', async (ctx) => {
    story(ctx, 'Od 120 % limitu transferu miniatura dostaje 429, dokładnie jak wideo i oryginał.');
    quotaWithUsage(1.2 * LIMIT);
    const res = await request(buildApp()).get('/events/evt-001/thumbnail');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Monthly transfer quota exceeded' });
    expect(getObject).not.toHaveBeenCalled();
  });

  it('[API-EVENTS-056] a plan without a transfer limit is never throttled or blocked', async (ctx) => {
    story(ctx, 'Plan bez limitu transferu (limit 0) zawsze przepuszcza miniatury.');
    vi.mocked(checkAndResetTransfer).mockResolvedValue({ transferUsageBytes: 10 * LIMIT } as never);
    vi.mocked(getUserQuota).mockResolvedValue({ transferLimitBytes: 0 } as never);
    const res = await request(buildApp()).get('/events/evt-001/thumbnail');
    expect(res.status).toBe(200);
  });
});
