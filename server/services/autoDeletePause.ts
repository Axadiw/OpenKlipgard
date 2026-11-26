// server/services/autoDeletePause.ts
//
// API-CORE-050: automatic deletion (the retention pass, the quota tidy and the
// oldest-first eviction) never deletes a file of a locked account, nor of an
// account the edition calls suspended.
import { isAccessLocked } from '../db/queries/access.js';
import { editionHooks } from '../hooks.js';

/**
 * Whether automatic deletion is paused for the account. The callers ask before
 * every file (API-CORE-118), so a lock or a suspension that appears during a
 * run stops it at the next file. A failed lookup rejects: it never means "not
 * paused", so nothing is deleted when the answer is unknown.
 */
export async function autoDeletePaused(userId: number): Promise<boolean> {
  if (await isAccessLocked(userId)) return true;
  return (await editionHooks().accountSuspended?.(userId)) === true;
}
