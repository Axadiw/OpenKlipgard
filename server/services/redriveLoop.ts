/**
 * The redrive tick loop of the Cloud Deployment (JOBS-016..018), kept free of
 * process, filesystem and timer globals so tests can drive it.
 *
 * - A tick starts `intervalMs` after the START of the previous tick, or at
 *   once when the previous tick took longer (JOBS-016).
 * - A tick that is still running after `tickTimeoutMs` cannot be cancelled,
 *   so `done` rejects with RedriveTickTimeoutError and the entrypoint exits
 *   with code 1 (JOBS-017). The pod restarts; the health file keeps its old
 *   time, so readiness reports the real silence.
 * - Only a tick that resolves counts as a success (JOBS-018).
 * - `stop()` (SIGTERM) lets the running tick finish and starts no new one.
 */
export interface RedriveLoopDeps {
  tick: () => Promise<void>;
  onSuccess: (atMs: number) => void | Promise<void>;
  onTickError: (err: unknown) => void;
  intervalMs: number;
  tickTimeoutMs: number;
  now: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class RedriveTickTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`redrive: tick exceeded ${timeoutMs / 1000}s`);
    this.name = 'RedriveTickTimeoutError';
  }
}

export interface RedriveLoop {
  /** Resolves once the loop has stopped; rejects with RedriveTickTimeoutError on a hung tick. */
  done: Promise<void>;
  /** Finish the running tick, start no new one. */
  stop: () => void;
}

export type TickOutcome = 'ok' | 'error' | 'timeout';

/** setTimeout as a promise that resolves early when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function startRedriveLoop(deps: RedriveLoopDeps): RedriveLoop {
  const ctrl = new AbortController();
  let stopped = false;

  async function runOne(): Promise<TickOutcome> {
    const timeoutCtrl = new AbortController();
    let timedOut = false;
    const timer = deps.sleep(deps.tickTimeoutMs, timeoutCtrl.signal).then(() => {
      if (!timeoutCtrl.signal.aborted) timedOut = true;
    });
    try {
      const outcome = await Promise.race([
        deps.tick().then(() => 'ok' as const, (err) => { deps.onTickError(err); return 'error' as const; }),
        timer.then(() => (timedOut ? ('timeout' as const) : new Promise<never>(() => {}))),
      ]);
      return outcome;
    } finally {
      timeoutCtrl.abort();
    }
  }

  const done = (async () => {
    while (!stopped) {
      const startedAt = deps.now();
      const outcome = await runOne();
      if (outcome === 'timeout') throw new RedriveTickTimeoutError(deps.tickTimeoutMs);
      if (outcome === 'ok') await deps.onSuccess(deps.now());
      if (stopped) break;
      const wait = Math.max(0, startedAt + deps.intervalMs - deps.now());
      if (wait > 0) await deps.sleep(wait, ctrl.signal);
    }
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      ctrl.abort();
    },
  };
}
