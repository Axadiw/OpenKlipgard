import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import type { UserCameraProfile } from '../../types.js';

vi.mock('../../db/queries/cameraProfiles.js', () => ({
  getCameraProfileSettings: vi.fn(),
  updateUserCameraProfile: vi.fn(),
}));

// The worker timeout is read at module load (and covers worker spawn). Keep it generous so a
// loaded CI runner never false-times-out a SAFE regex; the catastrophic case below stays
// catastrophic by input length (x+x+)+y on 50 x's (~2^50 steps, minutes) never finishes within the budget.
const WORKER_TIMEOUT_MS = 3000;

const EVIL = '^(?<camera>(x+x+)+y)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
const SAFE = '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$';

function row(id: number, regex: string): UserCameraProfile {
  return {
    id,
    name: `p${id}`,
    regex,
    viewDefault: '00',
    viewsConfig: [{ id: '00', iconKind: 'generic' }],
    priority: 10,
    enabled: true,
    createdAt: '2026-05-30T00:00:00.000Z',
  };
}

async function load() {
  vi.resetModules();
  vi.stubEnv('UNTRUSTED_REGEX_TIMEOUT_MS', String(WORKER_TIMEOUT_MS));
  const resolver = await import('../cameraProfileResolver.js');
  const cfg = await import('../../config/cameraProfiles.js');
  const parse = await import('./filenameParse.js');
  const rx = await import('../untrustedRegex.js');
  const q = await import('../../db/queries/cameraProfiles.js');
  return { resolver, cfg, parse, rx, q };
}

describe('custom camera-profile regex never runs on the main thread', () => {
  let shutdown: (() => Promise<void>) | undefined;
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await shutdown?.(); });

  it('a vetted custom regex never executes on the main thread (catastrophic input does not block the event loop)', { timeout: 30000 }, async () => {
    const { resolver, cfg, rx, q } = await load();
    shutdown = rx._shutdownRegexWorker;
    // Warm the worker up first so spawn latency is not part of what the vet below measures.
    await rx.safeRegexExec('^a$', 'i', 'a');
    const p = resolver.buildCustomProfile(row(1, EVIL));
    // The six-probe vet does not catch this pattern, so it would be flipped trusted.
    expect(await rx.assertUntrustedRegexSafe(p.regex.source, p.regex.flags)).toBeNull();
    const vetted = { ...p, untrusted: false };
    const input = 'x'.repeat(50) + '.mp4';

    // (a) the sync classifier must refuse custom profiles outright
    const t0 = Date.now();
    expect(cfg.classifyFilename(input, [vetted])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);

    // (b) async path: times out in the worker, loop stays responsive, profile disabled
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t1 = Date.now();
    const out = await resolver.classifyFilenameAsync(input, [vetted], 'u');
    clearInterval(timer);
    expect(out).toBeNull();
    expect(Date.now() - t1).toBeLessThan(WORKER_TIMEOUT_MS + 6000);
    expect(ticks).toBeGreaterThan(0);
    expect(q.updateUserCameraProfile).toHaveBeenCalledWith(1, 'u', { enabled: false });
  });

  it('a safe custom regex still classifies through parseS3KeysAsync', { timeout: 30000 }, async () => {
    const { resolver, parse, rx } = await load();
    shutdown = rx._shutdownRegexWorker;
    const p = resolver.buildCustomProfile(row(2, SAFE));
    const out = await parse.parseS3KeysAsync(
      [{ key: 'u/Front_00_20260622094413.mp4', size: 1 }], 'u/', [{ ...p, untrusted: false }], 'u',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ camera: 'Front', view: '00', tsRaw: '20260622094413' });
  });
});
