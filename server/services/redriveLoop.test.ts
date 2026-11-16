import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { abortableSleep, startRedriveLoop, RedriveTickTimeoutError, type RedriveLoopDeps } from './redriveLoop.js';
import { story } from '../testing/story.js';

const T0 = Date.parse('2026-11-12T12:00:00Z');

/** A tick that takes `ms` of (fake) time, then resolves or rejects. */
const tickTaking = (ms: number, fail = false) => () =>
  new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('db down')) : resolve()), ms));

function deps(over: Partial<RedriveLoopDeps>): RedriveLoopDeps & { successes: number[]; errors: unknown[] } {
  const successes: number[] = [];
  const errors: unknown[] = [];
  return {
    tick: tickTaking(0),
    onSuccess: (at) => { successes.push(at); },
    onTickError: (err) => { errors.push(err); },
    intervalMs: 60_000,
    tickTimeoutMs: 60_000,
    now: Date.now,
    sleep: abortableSleep,
    successes,
    errors,
    ...over,
  };
}

describe('startRedriveLoop', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts a tick 60 s after the start of the previous one (JOBS-016)', async (ctx) => {
    story(ctx, 'Redrive w jednym procesie uruchamia kolejny przebieg minutę po starcie poprzedniego, niezależnie od tego, ile trwał przebieg.');
    const starts: number[] = [];
    const d = deps({ tick: () => { starts.push(Date.now() - T0); return tickTaking(10_000)(); } });
    const loop = startRedriveLoop(d);
    await vi.advanceTimersByTimeAsync(185_000);
    expect(starts).toEqual([0, 60_000, 120_000, 180_000]);
    expect(d.successes.map((t) => t - T0)).toEqual([10_000, 70_000, 130_000]);
    loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await loop.done;
  });

  it('starts the next tick at once when a tick took longer than the interval', async () => {
    const starts: number[] = [];
    const d = deps({ intervalMs: 30_000, tick: () => { starts.push(Date.now() - T0); return tickTaking(45_000)(); } });
    const loop = startRedriveLoop(d);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(starts).toEqual([0, 45_000, 90_000]);
    loop.stop();
    await vi.advanceTimersByTimeAsync(45_000);
    await loop.done;
  });

  it('a failed tick is reported, not counted as a success, and the loop goes on (JOBS-015, JOBS-018)', async (ctx) => {
    story(ctx, 'Nieudany przebieg redrive trafia do raportu błędów i nie odświeża znacznika zdrowia; następny przebieg rusza normalnie minutę później.');
    let n = 0;
    const d = deps({ tick: () => tickTaking(1_000, ++n === 1)() });
    const loop = startRedriveLoop(d);
    await vi.advanceTimersByTimeAsync(62_000);
    expect(d.errors).toHaveLength(1);
    expect(d.successes.map((t) => t - T0)).toEqual([61_000]);
    loop.stop();
    await loop.done;
  });

  it('a tick still running after 60 s rejects the loop with a timeout (JOBS-017)', async (ctx) => {
    story(ctx, 'Zawieszony przebieg redrive (ponad 60 s) kończy pętlę błędem, więc proces wychodzi z kodem 1 i Kubernetes go restartuje.');
    const d = deps({ tick: () => new Promise<void>(() => {}) });
    const loop = startRedriveLoop(d);
    const settled = loop.done.then(() => 'resolved', (err) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await settled;
    expect(result).toBeInstanceOf(RedriveTickTimeoutError);
    expect(d.successes).toEqual([]);
  });

  it('stop() lets the running tick finish and starts no new one (JOBS-017)', async (ctx) => {
    story(ctx, 'Na SIGTERM redrive kończy bieżący przebieg i nie zaczyna kolejnego.');
    let ticks = 0;
    const d = deps({ tick: () => { ticks += 1; return tickTaking(5_000)(); } });
    const loop = startRedriveLoop(d);
    await vi.advanceTimersByTimeAsync(2_000);
    loop.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await loop.done;
    expect(ticks).toBe(1);
    expect(d.successes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ticks).toBe(1);
  });

  it('stop() while waiting for the next tick ends the loop at once', async () => {
    const d = deps({});
    const loop = startRedriveLoop(d);
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    await loop.done;
    expect(d.successes).toHaveLength(1);
  });
});
