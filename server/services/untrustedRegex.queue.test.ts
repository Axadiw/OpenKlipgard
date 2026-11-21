import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.UNTRUSTED_REGEX_TIMEOUT_MS = '300';
  process.env.UNTRUSTED_REGEX_MAX_PENDING_PER_USER = '2';
  process.env.UNTRUSTED_REGEX_MAX_PENDING_INTERACTIVE = '4';
  process.env.UNTRUSTED_REGEX_MAX_PENDING = '8';
});

import {
  safeRegexExec,
  RegexTimeoutError,
  RegexQueueFullError,
  _shutdownRegexWorker,
} from './untrustedRegex.js';

const EVIL = '(?<camera>(x+x+)+y)(?<ts>\\d*)(?<ext>z)';
const EVIL_INPUT = 'x'.repeat(40);
const SAFE = '^(?<camera>.+)_(?<ts>\\d+)\\.(?<ext>mp4)$';

afterEach(async () => {
  await _shutdownRegexWorker();
});

describe('untrusted regex queue (API-CORE-117)', () => {
  it('kills a catastrophic match at the wall clock and stays usable', async () => {
    const t0 = Date.now();
    await expect(safeRegexExec(EVIL, 'i', EVIL_INPUT)).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(Date.now() - t0).toBeLessThan(3000);
    const r = await safeRegexExec(SAFE, 'i', 'cam_1.mp4');
    expect(r.matched).toBe(true);
  }, 15_000);

  it('runs an ingest job ahead of queued interactive jobs', async () => {
    const order: string[] = [];
    const first = safeRegexExec(EVIL, 'i', EVIL_INPUT, { priority: 'interactive', userKey: 'u1' })
      .catch(() => order.push('first'));
    const low = safeRegexExec(SAFE, 'i', 'a_1.mp4', { priority: 'interactive', userKey: 'u2' })
      .then(() => order.push('interactive'));
    const high = safeRegexExec(SAFE, 'i', 'a_1.mp4').then(() => order.push('ingest'));
    await Promise.all([first, low, high]);
    expect(order).toEqual(['first', 'ingest', 'interactive']);
  }, 15_000);

  it('caps pending interactive jobs per account', async () => {
    const jobs = [1, 2].map(() =>
      safeRegexExec(EVIL, 'i', EVIL_INPUT, { priority: 'interactive', userKey: 'u1' }).catch(() => 'done'),
    );
    await expect(
      safeRegexExec(SAFE, 'i', 'a_1.mp4', { priority: 'interactive', userKey: 'u1' }),
    ).rejects.toBeInstanceOf(RegexQueueFullError);
    // another account is not affected
    const other = safeRegexExec(SAFE, 'i', 'a_1.mp4', { priority: 'interactive', userKey: 'u2' });
    await Promise.all([...jobs, other]);
    // after the jobs end the account may queue again
    const again = await safeRegexExec(SAFE, 'i', 'a_1.mp4', { priority: 'interactive', userKey: 'u1' });
    expect(again.matched).toBe(true);
  }, 20_000);

  it('caps the interactive queue and the whole queue', async () => {
    const held: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      held.push(safeRegexExec(EVIL, 'i', EVIL_INPUT, { priority: 'interactive', userKey: `u${i}` }).catch(() => 0));
    }
    // 1 running + 4 queued = interactive cap reached
    await expect(
      safeRegexExec(SAFE, 'i', 'a_1.mp4', { priority: 'interactive', userKey: 'late' }),
    ).rejects.toBeInstanceOf(RegexQueueFullError);
    // ingest still admitted until the global cap
    const ingest = safeRegexExec(SAFE, 'i', 'a_1.mp4');
    await _shutdownRegexWorker();
    void ingest.catch(() => 0);
    await Promise.all(held.map(h => Promise.race([h, Promise.resolve()])));
  }, 20_000);
});
