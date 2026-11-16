// Consumer of `stream:ftps-prefix-deleted` ([FTPS-102]).
//
// FTPS publishes `{userUuid, prefix}` after it swept a directory: the objects
// are gone, and this handler brings the records under that prefix in line.
// FTPS also publishes one `stream:delete-notify` per object it listed, so most
// records are already gone when this message arrives. The handler therefore
// has to be idempotent: a second run over a key that is already clean finds
// nothing, deletes nothing and counts nothing.
//
// It writes nothing itself. Every record goes through `handleDeleteNotify`,
// which owns `removeFileMetadata`, `removeDeletedFileFromEvents` and
// `deleteSidecarsForRecording`; this file only finds the keys. The metric
// `recordEventsDeleted` is therefore counted from the events that were
// actually deleted, not from the number of keys the prefix matched.
import { CONFIG } from '../config.js';
import {
  getFileMetadataKeysUnderPrefix,
  getViewPathsUnderPrefix,
} from '../db/queries/events.js';
import { getUserInternalIdByUuid } from '../db/queries/users.js';
import { handleDeleteNotify } from './deleteNotifyHandler.js';
import { listObjectsStream } from './s3.js';
import { getCachedUserInternalId } from './userIdCache.js';

export interface PrefixDeleted {
  userUuid: string;
  /** Key prefix of the swept directory, with the `{userUuid}/` part, no trailing slash. */
  prefix: string;
}

export interface PrefixDeletedDeps {
  ownerIdOf: (userUuid: string) => Promise<number | null>;
  fileKeys: (ownerId: number, bucket: string, keyPrefix: string) => Promise<string[]>;
  viewPaths: (ownerId: number, relPrefix: string) => Promise<string[]>;
  /** Keys that still exist in the recordings bucket under the prefix. */
  liveKeys: (bucket: string, keyPrefix: string) => Promise<Set<string>>;
  deleteNotify: (n: { userUuid: string; s3Key: string }) => Promise<void>;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys handled at the same time for one message. */
const CONCURRENCY = 8;

async function liveKeysFromBucket(bucket: string, keyPrefix: string): Promise<Set<string>> {
  const live = new Set<string>();
  for await (const obj of listObjectsStream(bucket, keyPrefix)) live.add(obj.key);
  return live;
}

const defaultDeps: PrefixDeletedDeps = {
  ownerIdOf: (uuid) => getCachedUserInternalId(uuid, getUserInternalIdByUuid),
  fileKeys: (ownerId, bucket, keyPrefix) => getFileMetadataKeysUnderPrefix(ownerId, bucket, keyPrefix),
  viewPaths: (ownerId, relPrefix) => getViewPathsUnderPrefix(ownerId, relPrefix),
  liveKeys: liveKeysFromBucket,
  deleteNotify: (n) => handleDeleteNotify(n),
};

/**
 * Returns the number of keys it handed to the delete-notify handler.
 * Throws when the object store listing or a query fails, so the stream
 * delivers the message again.
 */
export async function handlePrefixDeleted(
  { userUuid, prefix }: PrefixDeleted,
  deps: PrefixDeletedDeps = defaultDeps,
): Promise<number> {
  const trimmed = prefix.replace(/\/+$/, '');
  // The prefix MUST stay inside the account the message names. A uuid that is
  // not one, or a prefix of another account, ends the message here.
  if (!UUID_SHAPE.test(userUuid) || (trimmed !== userUuid && !trimmed.startsWith(`${userUuid}/`))) {
    console.warn(`event-manager: prefix-deleted ignored, prefix ${JSON.stringify(prefix)} is not under account ${userUuid}`);
    return 0;
  }
  const ownerId = await deps.ownerIdOf(userUuid);
  if (ownerId === null) {
    console.warn(`event-manager: unknown userUuid=${userUuid} in prefix-deleted, skipping`);
    return 0;
  }

  const keyPrefix = `${trimmed}/`;
  const relPrefix = keyPrefix.slice(userUuid.length + 1);
  const bucket = CONFIG.s3RecordingsBucket;

  const [rowKeys, viewRels] = await Promise.all([
    deps.fileKeys(ownerId, bucket, keyPrefix),
    deps.viewPaths(ownerId, relPrefix),
  ]);
  const candidates = new Set<string>(rowKeys);
  for (const rel of viewRels) candidates.add(`${userUuid}/${rel}`);
  if (candidates.size === 0) return 0;

  // A camera can write into the directory again before this message is read.
  // An object that exists keeps its records.
  const live = await deps.liveKeys(bucket, keyPrefix);
  const gone = [...candidates].filter((key) => !live.has(key));

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < gone.length) {
      const s3Key = gone[next++];
      await deps.deleteNotify({ userUuid, s3Key });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, gone.length) }, worker));

  if (gone.length > 0) {
    console.log(`event-manager: prefix-deleted ${keyPrefix} → swept ${gone.length} record key(s)`);
  }
  return gone.length;
}
