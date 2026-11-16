/**
 * Redrive as one long-running process (JOBS-016..018), the Cloud Deployment
 * `klipgard-redrive`. The per-minute CronJob it replaces paid a full Node start
 * (Sentry + db layer + edition graph, ~1 CPU core for ~18 s) every minute on
 * the 2-vCPU control-plane node, even when the tick had nothing to do. Here
 * that start happens once; a steady-state tick is one indexed query.
 *
 * Health (JOBS-018): after each successful tick the time goes to
 * REDRIVE_HEALTH_FILE; the pod's exec readiness probe reads its age, and the
 * cron watchdog pages when the Deployment stays unavailable (JOBS-075).
 */
import { writeFileSync } from 'node:fs';
import { captureException, closeErrorReporting } from './errorReporting.js';
import { initDb } from './db/index.js';
import { runRedriveTick } from './services/redrive.js';
import { abortableSleep, startRedriveLoop } from './services/redriveLoop.js';
import { closeRedis } from './utils/redis.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

const TICK_INTERVAL_MS = 60_000;
const TICK_TIMEOUT_MS = 60_000;
const HEALTH_FILE = process.env.REDRIVE_HEALTH_FILE || '/tmp/redrive-last-ok';

async function main(): Promise<void> {
  await initDb();
  console.log('redrive-loop: started');

  const loop = startRedriveLoop({
    tick: runRedriveTick,
    onSuccess: (atMs) => {
      // Seconds since the epoch, one line: the readiness probe compares it to `date +%s`.
      writeFileSync(HEALTH_FILE, `${Math.floor(atMs / 1000)}\n`);
    },
    onTickError: (err) => {
      console.error('redrive: tick failed:', err instanceof Error ? err.stack ?? err.message : String(err));
      captureException(err);
    },
    intervalMs: TICK_INTERVAL_MS,
    tickTimeoutMs: TICK_TIMEOUT_MS,
    now: Date.now,
    sleep: abortableSleep,
  });

  const onSignal = (sig: string) => {
    console.log(`redrive-loop: ${sig}, finishing the current tick`);
    loop.stop();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  await loop.done;
}

main()
  .then(async () => {
    console.log('redrive-loop: stopped');
    await closeRedis().catch(() => {});
    await closeErrorReporting(2000);
    process.exit(0);
  })
  .catch(async (err) => {
    // A hung tick may hold a wedged connection that never closes cleanly;
    // exit 1 no matter what after 5 s (JOBS-017).
    setTimeout(() => process.exit(1), 5000).unref();
    console.error('redrive-loop: failed:', err instanceof Error ? err.stack ?? err.message : String(err));
    captureException(err);
    await closeErrorReporting(2000);
    await closeRedis().catch(() => {});
    process.exit(1);
  });
