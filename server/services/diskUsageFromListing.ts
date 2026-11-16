// [DATA-130] One method for "how much disk does this account use": the sum of
// the sizes of the objects listed under `{uuid}/` in the recordings bucket,
// folder markers counted as their own 0 bytes. The storage reconciler (step 1)
// adds the same sizes inside its listing loop. The content wipe uses this
// function after it has deleted the objects, so the two never disagree about a
// row-less or object-less file.
import { CONFIG } from '../config.js';
import { setDiskUsageAbsolute } from '../db/queries/storage.js';
import { listObjectsStream } from './s3.js';

type ListFn = (bucket: string, prefix: string) => AsyncIterable<{ size: number }>;

/** Sum of the object sizes under the account prefix in the recordings bucket. */
export async function sumRecordingsBytes(userUuid: string, list: ListFn = listObjectsStream): Promise<number> {
  let bytes = 0;
  for await (const obj of list(CONFIG.s3RecordingsBucket, `${userUuid}/`)) bytes += obj.size;
  return bytes;
}

/**
 * Set `disk_usage_bytes` to the listed total. Returns the new value, or null
 * when the listing failed: the counter then keeps its value and the next
 * storage reconciliation sets it by the same sum.
 */
export async function syncDiskUsageFromListing(
  userId: number,
  userUuid: string,
  list: ListFn = listObjectsStream,
): Promise<number | null> {
  let bytes: number;
  try {
    bytes = await sumRecordingsBytes(userUuid, list);
  } catch (err) {
    console.warn(
      `disk usage: listing failed for account #${userId}, keeping the counter:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  await setDiskUsageAbsolute(userId, bytes);
  return bytes;
}
