import type { JobResult, MatchJob } from './cameraPattern';
import { PREVIEW_LIMIT_MS } from './cameraPattern';
import type { WorkerReply } from './cameraPattern.worker';

/** How long a worker may take to load before the preview counts as not
 *  available. Generous on purpose: on a busy machine or a cold cache the
 *  module load alone can take seconds, and it says nothing about the pattern. */
export const WORKER_START_LIMIT_MS = 10_000;

export type BatchOutcome =
  | { kind: 'ok'; results: JobResult[] }
  | { kind: 'timeout' }
  | { kind: 'unavailable' };

/**
 * Run a batch of pattern jobs in a fresh Web Worker under a wall-clock limit
 * (WEB-SET-CAMERAS-081). A fresh worker per batch keeps a stuck match from
 * affecting the next one: on timeout the worker is terminated.
 *
 * The limit starts when the worker says it is ready, not when it is created.
 * Counting the module load judged safe patterns "too slow" on a loaded
 * machine, the same trap as the server's ReDoS worker (AGENTS.md, CI stability).
 */
export function runBatch(jobs: MatchJob[], limitMs: number = PREVIEW_LIMIT_MS, startLimitMs: number = WORKER_START_LIMIT_MS): Promise<BatchOutcome> {
  if (typeof Worker === 'undefined') return Promise.resolve({ kind: 'unavailable' });
  return new Promise<BatchOutcome>(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./cameraPattern.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ kind: 'unavailable' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startTimer = setTimeout(() => {
      worker.terminate();
      resolve({ kind: 'unavailable' });
    }, startLimitMs);
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      if (e.data.type === 'ready') {
        clearTimeout(startTimer);
        timer = setTimeout(() => {
          worker.terminate();
          resolve({ kind: 'timeout' });
        }, limitMs);
        worker.postMessage(jobs);
        return;
      }
      clearTimeout(timer);
      worker.terminate();
      resolve({ kind: 'ok', results: e.data.results });
    };
    worker.onerror = () => {
      clearTimeout(startTimer);
      clearTimeout(timer);
      worker.terminate();
      resolve({ kind: 'unavailable' });
    };
  });
}
