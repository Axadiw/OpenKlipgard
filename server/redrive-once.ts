/**
 * Redrive, one tick per process. The self-hosted scheduler runs this once a
 * minute (JOBS-090). Klipgard Cloud runs the same tick in one long-running
 * process instead, `redrive-loop-entry.ts` (JOBS-016): a Node start with the
 * whole app graph costs ~20 CPU-seconds, far more than a steady-state tick.
 * The passes themselves live in `services/redrive.ts`.
 */
import { captureException, closeErrorReporting } from './errorReporting.js';
import { initDb } from './db/index.js';
import { runRedriveTick } from './services/redrive.js';
import { closeRedis } from './utils/redis.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

async function main(): Promise<void> {
  await initDb();
  await runRedriveTick();
}

main()
  .then(async () => { await closeRedis(); await closeErrorReporting(200); process.exit(0); })
  .catch(async (err) => {
    console.error('redrive: failed:', err instanceof Error ? err.stack ?? err.message : String(err));
    captureException(err);
    await closeErrorReporting(2000);
    await closeRedis().catch(() => {});
    process.exit(1);
  });
