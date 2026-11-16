import { CONFIG } from '../config.js';
import { getEventByIdForOwner, THUMBNAIL_UNPLAYABLE } from '../db/queries/events.js';
import { deleteEventAndThumbnail } from './eventCleanup.js';
import { deleteS3AndMetadata, deleteRecordingAllBuckets } from './fileLifecycle.js';
import { resolveS3Path } from '../utils/s3path.js';

/**
 * Remove every S3 object associated with an event (wide, zoom, thumbnail)
 * and drop the DB row. Updates `disk_usage_bytes` inline so the user's
 * usage display in Settings reflects the freed space immediately — the
 * 1-min `storageReconciler` is still the safety net for any drift, but
 * it can't be the primary path because the UX of "click delete, see your
 * GBs free up only after 1 min" is bad. Pre-v0.10.12 this was the
 * documented behaviour; flagged + fixed after a user report.
 *
 * Size source priority:
 *   1. `file_metadata.file_size_bytes` — populated by the FTPS upload hook
 *      and by the reconciler's S3-list backfill, so it covers everything
 *      from this release forward + everything seen by at least one
 *      reconciler pass.
 *   2. S3 HEAD with the user's SSE-C salt — fallback for legacy events that
 *      predate the file_metadata FIFO and haven't been reconciler-touched.
 *   3. Skip the decrement — last resort if both above fail (S3 already gone
 *      / IAM blip / etc.). The reconciler will sync `disk_usage_bytes`
 *      from the real S3 sum on its next pass.
 *
 * Generated thumbnails (`__s3_thumb__/...`) live in the thumbnails bucket
 * and don't count against the user's quota — we still delete them, but we
 * don't include their size in the inline decrement.
 */
export async function deleteEventOwned(
  eventId: string,
  userId: number,
  userUuid: string,
): Promise<'ok' | 'not_found'> {
  const event = await getEventByIdForOwner(eventId, userId);
  if (!event) return 'not_found';

  const paths = [...event.views.map(l => l.videoRelPath), event.thumbnail]
    .filter((p): p is string => !!p && p !== THUMBNAIL_UNPLAYABLE);

  for (const p of paths) {
    const loc = resolveS3Path(userUuid, p);
    if (!loc) continue;
    try {
      if (loc.bucket === CONFIG.s3RecordingsBucket) {
        // deleteRecordingAllBuckets deletes: the recording itself, the
        // per-recording .jpg thumbnail, and the .fmp4patch sidecar — all
        // with file_metadata + disk_usage_bytes cascade via deleteS3AndMetadata.
        await deleteRecordingAllBuckets({
          ownerId: userId,
          recordingS3Key: loc.key,
          reason: 'event-delete',
        });
      } else {
        // Thumbnails bucket (generated __s3_thumb__ entries or camera-uploaded
        // JPGs stored there). No sidecar exists for these.
        await deleteS3AndMetadata({
          ownerId: userId,
          s3Bucket: loc.bucket,
          s3Key: loc.key,
          reason: 'event-delete',
        });
      }
    } catch (err) {
      console.warn(
        `delete event ${eventId}: lifecycle delete failed for ${loc.key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // deleteEventAndThumbnail also removes the generated `__generated__/{id}.jpg`
  // thumbnail from the thumbnails bucket — its file_metadata row (if any)
  // gets cleaned by the safety-net loop. Disk usage decrement now happens
  // inside deleteS3AndMetadata per recording bucket row.
  await deleteEventAndThumbnail(eventId, userId, userUuid, 'user');

  return 'ok';
}
