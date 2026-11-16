import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBatch } from './cameraPatternRunner';
import type { MatchJob } from './cameraPattern';

/** A stand-in Worker: the test decides when it reports ready and answers. */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; }
  postMessage(data: unknown) { this.posted.push(data); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

const jobs = [{ pattern: 'x', name: 'x' }] as unknown as MatchJob[];

describe('runBatch [WEB-SET-CAMERAS-081]', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeWorker.last = null; });

  it('does not count a slow worker start against the 500 ms match limit', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const outcome = runBatch(jobs, 500, 10_000);
    const w = FakeWorker.last!;
    // The module takes 3 s to load: far over the match limit, but nothing has run yet.
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.posted).toEqual([]);
    w.emit({ type: 'ready' });
    expect(w.posted).toEqual([jobs]);
    await vi.advanceTimersByTimeAsync(100);
    w.emit({ type: 'results', results: [] });
    await expect(outcome).resolves.toEqual({ kind: 'ok', results: [] });
    expect(w.terminated).toBe(true);
  });

  it('times out a match that runs past the limit after ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const outcome = runBatch(jobs, 500, 10_000);
    FakeWorker.last!.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(501);
    await expect(outcome).resolves.toEqual({ kind: 'timeout' });
    expect(FakeWorker.last!.terminated).toBe(true);
  });

  it('reports the preview as unavailable when the worker never gets ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const outcome = runBatch(jobs, 500, 10_000);
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(outcome).resolves.toEqual({ kind: 'unavailable' });
  });
});
