import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import type { CameraEvent, JwtPayload } from '../types.js';
import { story } from '../testing/story.js';

// Mocks — as in events.security.test.ts, EXCEPT the mdat cache, the mp4
// helpers and the concurrency middleware, which run for real.
vi.mock('../db/queries/events.js', () => ({
  getEvents: vi.fn(),
  getEventByIdForOwner: vi.fn(),
  getCameraNames: vi.fn(() => Promise.resolve(['cam1'])),
  getCameraDetails: vi.fn(() => Promise.resolve([])),
  getEventCalendar: vi.fn(() => Promise.resolve([])),
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
  getFileMetadataByKey: vi.fn(() => Promise.resolve({
    id: 1, ownerId: 1, s3Bucket: 'recordings', s3Key: 'uuid-aaa-111/x.mp4',
    originalFilename: 'x.mp4', fileSizeBytes: 1, uploadedAt: '2026-01-01T00:00:00Z',
  })),
  getPlaybackPatchState: vi.fn(() => Promise.resolve({
    readyAt: new Date(), unplayable: false, attempts: 0,
  })),
  deleteEvent: vi.fn(() => Promise.resolve()),
  getFileMetadataSize: vi.fn(() => Promise.resolve(null)),
  removeFileMetadata: vi.fn(() => Promise.resolve()),
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
  invalidateSidecar: vi.fn(),
  // Default to NotFound so the route takes the pass-through (class B/C) path
  // and exercises the headObject + range stream path that the security tests
  // assert on.
  getSidecar: vi.fn(() => {
    const err = new Error('NoSuchKey') as Error & { name: string; $metadata: { httpStatusCode: number } };
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    return Promise.reject(err);
  }),
}));

vi.mock('../services/s3.js', () => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
  // cachedHeadObject (v0.10.272+) wraps headObject with Redis caching on the
  // hot /video path. For these security tests we don't care about the Redis
  // layer — alias both names to the same vi.fn() so `vi.mocked(headObject)`
  // continues to drive both mock'd call sites. If a future test needs to
  // assert on the cache layer specifically (cache hit vs miss), promote
  // cachedHeadObject to its own vi.fn() and the asserting test can override.
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
  // Spy wrapper (not a bare arrow) so tests can assert the frames route — and
  // every other media route — actually runs the media rate limiter.
  mediaRateLimit: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  apiRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  diskInfoRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    itemsPerPage: 50,
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
    mediaTokenExpirySeconds: 900,
    // Enabled so the `?fmt=clean` clean-frame serve path is reachable in the
    // listener-leak test below; other tests don't pass fmt=clean so they skip it.
    cleanFrameEnabled: true,
  },
}));

import eventsRouter from './events.js';
import { getEventByIdForOwner } from '../db/queries/events.js';
import { getUserByInternalId } from '../db/queries/users.js';
import { getObject, headObject, cachedHeadObject } from '../services/s3.js';
import { getSidecar } from '../services/sidecarCache.js';
import { cleanFrameSidecarCache } from '../services/cleanFrameSidecarCache.js';
import { _resetMdatCacheForTests } from '../utils/mdatCache.js';
import { _resetForTesting as resetConcurrency } from '../middleware/concurrencyLimit.js';
import { buildSidecarForFile } from '../services/mp4/sidecarBuilder.js';
import { parseSidecar } from '../services/mp4/sidecar.js';
import { parseMfraEntries, computeSidxSize } from '../services/mp4/seekTables.js';
import { box, makeFtyp, makeMoov, makeMoofMdat } from '../services/mp4/__test-fixtures.js';

const USER_A: JwtPayload = { userId: 1, userUuid: 'uuid-aaa-111', email: 'alice@test.com', isAdmin: false };

const EVENT: CameraEvent = {
  id: 'evt-001',
  camera: 'cam1',
  timestamp: '2025-12-01T10:00:00Z',
  date: '2025-12-01',
  views: [{ id: '00', videoRelPath: 'cam1/2025-12-01/wide.mp4' }],
  thumbnail: 'cam1/2025-12-01/thumb.jpg',
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

/** In-memory "bucket": serves any ranged GET from `file` and records the ranges. */
function backObjectStore(file: Buffer): string[] {
  const ranges: string[] = [];
  vi.mocked(getObject).mockImplementation((async (_b: string, _k: string, _s: string, range?: string) => {
    ranges.push(range ?? 'full');
    let a = 0;
    let z = file.length - 1;
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      a = Number(m[1]);
      z = Math.min(Number(m[2]), file.length - 1);
    }
    return { body: Readable.from([file.subarray(a, z + 1)]) };
  }) as unknown as typeof getObject);
  vi.mocked(headObject).mockResolvedValue({ contentLength: file.length } as never);
  return ranges;
}

function binary(r: request.Test) {
  return r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

const rangeLen = (r: string): number => {
  const m = /^bytes=(\d+)-(\d+)$/.exec(r);
  return m ? Number(m[2]) - Number(m[1]) + 1 : Infinity;
};

beforeEach(() => {
  vi.clearAllMocks();
  cleanFrameSidecarCache.clear();
  _resetMdatCacheForTests();
  resetConcurrency();
  vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT);
  vi.mocked(cachedHeadObject).mockImplementation(
    (...args: Parameters<typeof headObject>) => vi.mocked(headObject)(...args),
  );
  vi.mocked(getUserByInternalId).mockResolvedValue({
    id: USER_A.userUuid, email: USER_A.email, isAdmin: false, active: true, createdAt: '2025-01-01',
    internalId: USER_A.userId, passwordHash: 'hash', tokenGeneration: 1, encryptionSalt: 'salt-aaa',
  } as never);
});

// ---------------------------------------------------------------------------
// patched (class A) path
// ---------------------------------------------------------------------------

async function classAFixture() {
  const ftyp = makeFtyp();
  const moov = makeMoov({
    mvhdTimescale: 1000, mvhdDuration: 0,
    tracks: [{ id: 1, mdhdTimescale: 90000 }],
    withMvex: true, withMehd: false,
    trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
  });
  const frags = [0, 9000, 18000, 27000].map((t) =>
    makeMoofMdat({ trackId: 1, decodeTime: t, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 * 1024 }));
  const file = Buffer.concat([ftyp, moov, ...frags]);
  const built = await buildSidecarForFile(file, file.length, async (a, z) => file.subarray(a, z + 1));
  const sidecar = built.sidecar!;
  const { prelude, mfra } = parseSidecar(sidecar);
  const sidxLen = computeSidxSize(parseMfraEntries(mfra).length);
  const origMoovEnd = prelude.length;
  const zoneVirtStart = prelude.length + sidxLen;
  return { file, sidecar, origMoovEnd, zoneVirtStart };
}

describe('patched path: S3 cost of a request is bounded by what it asks for', () => {
  it('a 1-byte Range inside the mdat zone does not fetch the whole mdat zone', async (ctx) => {
    story(ctx, 'Zapytanie o jeden bajt z nagrania nie wymusza pobrania całego pliku z magazynu: zamiast 1:N dostaje dokładny zakres.');
    const fx = await classAFixture();
    const ranges = backObjectStore(fx.file);
    vi.mocked(getSidecar).mockResolvedValue(fx.sidecar);
    const phys = fx.origMoovEnd + 1000;
    fx.file[phys] = 0xab;
    const virt = fx.zoneVirtStart + 1000;

    const res = await binary(request(buildApp()).get('/events/evt-001/video/00').set('Range', `bytes=${virt}-${virt}`));

    expect(res.status).toBe(206);
    expect(res.body.length).toBe(1);
    expect(res.body[0]).toBe(0xab);
    expect(ranges).not.toContain(`bytes=${fx.origMoovEnd}-${fx.file.length - 1}`);
    expect(ranges).toEqual([`bytes=${phys}-${phys}`]);
  });

  it('a full GET fills the mdat cache once and a following small Range is served from memory', async (ctx) => {
    story(ctx, 'Gorąca ścieżka bez zmian: pierwsze pełne GET wypełnia cache strefy mdat jednym pobraniem, a kolejne przewijanie jest obsługiwane z pamięci bez żadnego wywołania S3.');
    const fx = await classAFixture();
    const ranges = backObjectStore(fx.file);
    vi.mocked(getSidecar).mockResolvedValue(fx.sidecar);
    const app = buildApp();

    const full = await binary(request(app).get('/events/evt-001/video/00'));
    expect(full.status).toBe(200);
    const zone = `bytes=${fx.origMoovEnd}-${fx.file.length - 1}`;
    expect(ranges.filter((r) => r === zone)).toHaveLength(1);

    const before = ranges.length;
    const virt = fx.zoneVirtStart + 5;
    const small = await binary(request(app).get('/events/evt-001/video/00').set('Range', `bytes=${virt}-${virt + 9}`));
    expect(small.status).toBe(206);
    expect(small.body.length).toBe(10);
    expect(ranges.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// pass-through (class B/C) path
// ---------------------------------------------------------------------------

function sidecarMissing() {
  vi.mocked(getSidecar).mockImplementation(() => {
    const err = new Error('NoSuchKey') as Error & { $metadata: { httpStatusCode: number } };
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    return Promise.reject(err);
  });
}

describe('pass-through path: the moov is read only when the response can differ', () => {
  it('pass-through: a Range outside the moov does not read the moov', async (ctx) => {
    story(ctx, 'Przewinięcie do środka pliku (zakres poza moov) nie kosztuje dodatkowego odczytu całego moov z magazynu: odpowiedź i tak jest bajt w bajt taka sama.');
    sidecarMissing();
    const ftyp = makeFtyp();
    const inner = makeMoov({ mvhdTimescale: 1000, mvhdDuration: 5000, tracks: [{ id: 1, mdhdTimescale: 90000 }] }).subarray(8);
    const moov = box('moov', Buffer.concat([inner, box('free', Buffer.alloc(256 * 1024))]));
    const mdat = box('mdat', Buffer.alloc(64 * 1024, 1));
    const file = Buffer.concat([ftyp, moov, mdat]);
    const off = ftyp.length + moov.length + 500;
    file[off] = 0xcd;
    const ranges = backObjectStore(file);

    const res = await binary(request(buildApp()).get('/events/evt-001/video/00').set('Range', `bytes=${off}-${off}`));

    expect(res.status).toBe(206);
    expect(res.body[0]).toBe(0xcd);
    expect(ranges.filter((r) => rangeLen(r) > 1000)).toEqual([]);
  });

  it('pass-through: a moov larger than the cap is never buffered', async (ctx) => {
    story(ctx, 'Plik z nagłówkiem moov deklarującym 8 MiB nie powoduje wczytania 8 MiB do pamięci przy każdym zapytaniu: powyżej limitu serwujemy surowe bajty.');
    sidecarMissing();
    const ftyp = makeFtyp();
    const bigSize = 8 * 1024 * 1024;
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(bigSize, 0);
    hdr.write('moov', 4, 'ascii');
    const file = Buffer.concat([ftyp, hdr, Buffer.alloc(bigSize - 8 + 1024, 2)]);
    const at = ftyp.length + 10;
    file[at] = 0xee;
    const ranges = backObjectStore(file);

    const res = await binary(request(buildApp()).get('/events/evt-001/video/00').set('Range', `bytes=${at}-${at}`));

    expect(res.status).toBe(206);
    expect(res.body[0]).toBe(0xee);
    expect(ranges.filter((r) => rangeLen(r) > 33)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 416 only after the stream shape and its total size are known (API-EVENTS-076)
// ---------------------------------------------------------------------------

describe('API-EVENTS-076: 416 is decided against the total size of the chosen shape', () => {
  it('[API-EVENTS-076] stitched shape: a Range starting at the original size is served, not refused', async (ctx) => {
    story(ctx, 'Odtwarzacz pobiera tablicę przewijania zakresem od rozmiaru oryginalnego pliku. Strumień sklejony jest dłuższy od oryginału, więc taki zakres musi dostać 206, a nie błędne 416.');
    const fx = await classAFixture();
    backObjectStore(fx.file);
    vi.mocked(getSidecar).mockResolvedValue(fx.sidecar);
    const app = buildApp();

    const full = await binary(request(app).get('/events/evt-001/video/00'));
    const total = full.body.length;
    expect(total).toBeGreaterThan(fx.file.length);

    const res = await binary(request(app).get('/events/evt-001/video/00').set('Range', `bytes=${fx.file.length}-`));

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${fx.file.length}-${total - 1}/${total}`);
    expect(res.body.length).toBe(total - fx.file.length);
  });

  it('[API-EVENTS-076] stitched shape: a Range at or past the stitched size is 416 and reports that size', async (ctx) => {
    story(ctx, 'Zakres poza końcem strumienia sklejonego dostaje 416, a nagłówek Content-Range niesie prawdziwy rozmiar strumienia, nie rozmiar oryginału.');
    const fx = await classAFixture();
    backObjectStore(fx.file);
    vi.mocked(getSidecar).mockResolvedValue(fx.sidecar);
    const app = buildApp();
    const total = (await binary(request(app).get('/events/evt-001/video/00'))).body.length;

    const res = await request(app).get('/events/evt-001/video/00').set('Range', `bytes=${total}-`);

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${total}`);
  });

  it('[API-EVENTS-076] pass-through shape: a Range at the original size is 416 with the original size', async (ctx) => {
    story(ctx, 'Plik klasy B/C jest wysyłany bajt w bajt, więc jego całkowity rozmiar to rozmiar oryginału, a zakres od tego rozmiaru jest nieosiągalny.');
    sidecarMissing();
    const file = Buffer.concat([makeFtyp(), box('mdat', Buffer.alloc(4096, 1))]);
    backObjectStore(file);

    const res = await request(buildApp()).get('/events/evt-001/video/00').set('Range', `bytes=${file.length}-`);

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${file.length}`);
  });
});
