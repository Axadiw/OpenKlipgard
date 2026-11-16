/**
 * One redrive tick: the four passes of JOBS-010..013, in order, each wrapped
 * alone so a failing pass logs and the next one still runs. Pass 1's batch
 * query is NOT wrapped: if Postgres is unreachable the tick fails as a whole,
 * which is what the health signal of JOBS-018 needs to see.
 *
 * Two callers: `redrive-once.ts` (one tick per process, run by the
 * self-hosted scheduler) and `redrive-loop-entry.ts` (one long-running
 * process, the Cloud Deployment). Both call `initDb()` first.
 */
import { getSidecarRedriveBatch } from '../db/queries/processingState.js';
import { reconcileMissingThumbnails, reconcileStalePlaybackReady } from './reconcilers.js';
import { relinkUnlinkedFiles } from './ingest/relinkUnlinkedFiles.js';
import { publishThumbnailUnique } from './streamsClient.js';

// Bounded so the relink pass (one completeUpload tx per orphan) cannot blow
// the 60 s tick limit: ~100 × ~50 ms ≈ 5 s worst case, sub-100 ms when empty
// (the steady state). The 6-hourly audit runs the 500-row variant.
export const REDRIVE_RELINK_LIMIT = 100;

export async function runRedriveTick(): Promise<void> {
  const batch = await getSidecarRedriveBatch();
  let published = 0;
  let deduped = 0;
  for (const { eventId, ownerId } of batch) {
    try {
      const r = await publishThumbnailUnique(eventId, ownerId, { notify: false });
      if (r === 'published') published += 1; else deduped += 1;
    } catch (err) {
      console.error('redrive: publish failed:', err instanceof Error ? err.message : String(err));
    }
  }
  if (batch.length > 0) {
    console.log(`redrive: ${published} published / ${deduped} deduped / ${batch.length} due`);
  }

  try {
    await relinkUnlinkedFiles(REDRIVE_RELINK_LIMIT);
  } catch (err) {
    console.error('redrive: relink failed:', err instanceof Error ? err.message : String(err));
  }

  // Events whose thumbnail job was never queued. The sidecar batch above only
  // sees files still in pending_sidecar, so an event created around an
  // already-ready file (a merge-artifact heal re-homing a displaced view) is
  // invisible to it and would keep a NULL thumbnail forever.
  try {
    await reconcileMissingThumbnails();
  } catch (err) {
    console.error('redrive: missing thumbnails failed:', err instanceof Error ? err.message : String(err));
  }

  try {
    await reconcileStalePlaybackReady();
  } catch (err) {
    console.error('redrive: stale playback_ready failed:', err instanceof Error ? err.message : String(err));
  }
}
