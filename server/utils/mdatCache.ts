/**
 * In-process LRU cache for the mdat zone of the fmp4-patched MP4 — i.e. the
 * full S3 GetObject body that `streamPatchedMp4` would normally range-read
 * on every request. Caching this byte stream eliminates the ONE remaining
 * S3 sub-call per `/video/:view` request (`headObject` is Redis-cached as
 * of v0.10.272, the sidecar is in-memory cached, and the patched-mp4
 * prelude / sidx / mfra all come from the sidecar). Range requests get
 * served by slicing the cached `Buffer`.
 *
 * Wedge fix lineage:
 *
 *   v0.10.211 baseline → wedge in ~70 s under 100 VU
 *   v0.10.268 cap=50    → 0 wedge (cap fires) but blocks legitimate users
 *   v0.10.272 head cache → eliminates 1 of 3 S3 sub-calls; wedge still
 *                          appears because the streaming mdat call still
 *                          eats a pool slot per request
 *   v0.10.273 (this)    → cache mdat bytes too; warm fan-out per request
 *                          drops to ZERO S3 calls. Stress survives 100 VU.
 *
 * Cap sizing:
 *
 *   Reolink wide+zoom clips are ~5-30 MB. With 20 unique events targeted
 *   by the stress reproducer the warm cache footprint is at most
 *   20 × 30 MB = 600 MB. Production load is more spread (hundreds of
 *   unique events across users) so the LRU eviction is the real bound:
 *   `MDAT_CACHE_MAX_BYTES` (default 500 MB) caps total memory and the LRU
 *   policy keeps the hot set resident. Pod memory limit is 2 Gi; 500 MB
 *   leaves comfortable headroom for the Node heap, native socket buffers,
 *   thumbnails LRU, etc.
 *
 *   Files larger than `MDAT_CACHE_MAX_FILE_BYTES` (default 50 MB) skip the
 *   cache entirely and fall back to the legacy S3 range-read path — the
 *   memory cost of caching a single 100 MB file isn't worth the eviction
 *   churn it causes for the smaller hot set.
 *
 * Concurrent-miss dedup:
 *
 *   When N requests for the same cold event arrive simultaneously (every
 *   stress run starts this way; in production it's the "deep-link to a
 *   viral clip" scenario), we fire ONE full-body `getObject` and have
 *   everyone await the same Promise. Without dedup, 100 cold requests
 *   for one popular event would each pull the full mp4 from S3 — exactly
 *   the wedge that this cache is meant to prevent. Pattern lifted from
 *   `services/sidecarCache.ts`.
 *
 * Per-user scoping (cache key includes a salt hash):
 *
 *   S3 SSE-C makes the on-disk bytes specific to the encryption key
 *   derived from the user's salt. Same (bucket, key) pulled with a
 *   DIFFERENT salt yields a different plaintext, so the cache must be
 *   keyed per user — otherwise user B querying the same s3 key as user A
 *   would get user A's plaintext from the cache. In practice this only
 *   matters defensively (the route-level ownership check in
 *   `resolveS3Path` already scopes s3 keys per user UUID, so no user
 *   can legitimately request another's key), but cache poisoning is the
 *   kind of thing we want to make impossible at the cache layer too.
 */
import { LRUCache } from 'lru-cache';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import type { Readable } from 'stream';

const MAX_BYTES = parseInt(
  process.env.MDAT_CACHE_MAX_BYTES || String(500 * 1024 * 1024),
  10,
);
const MAX_FILE_BYTES = parseInt(
  process.env.MDAT_CACHE_MAX_FILE_BYTES || String(50 * 1024 * 1024),
  10,
);

const cache = new LRUCache<string, Buffer>({
  maxSize: MAX_BYTES,
  sizeCalculation: (buf) => buf.length,
});

/**
 * Ceiling on the bytes being pulled by cache fills at the same time. The LRU
 * above only counts COMPLETED entries, so without this a burst of cold
 * requests for distinct files would each buffer a whole mdat zone (chunks +
 * the final concat) before any of them landed in the LRU. Over budget, the
 * caller gets `null` and falls back to the exact ranged GET.
 */
const MAX_INFLIGHT_BYTES = parseInt(
  process.env.MDAT_CACHE_MAX_INFLIGHT_BYTES || String(128 * 1024 * 1024),
  10,
);

interface InflightFill {
  promise: Promise<Buffer | null>;
  /** Requests currently waiting on this fill. At 0 the fill is aborted. */
  waiters: number;
  controller: AbortController;
  release: () => void;
}

const inflight = new Map<string, InflightFill>();
let inflightBytes = 0;

/** Build the cache key. Salt is hashed (sha256, 16-hex prefix) so we
 *  don't store the raw secret inside the cache map keys.  */
export function buildMdatCacheKey(bucket: string, key: string, userSalt: string): string {
  const saltHash = createHash('sha256').update(userSalt).digest('hex').slice(0, 16);
  return `${bucket}:${key}:${saltHash}`;
}

/**
 * Drain a Readable into a Buffer, refusing to keep anything larger than
 * `MAX_FILE_BYTES`. Returning `null` (rather than throwing) lets the caller
 * fall through to the legacy range-read path — a missing cache entry is a
 * fast-path miss, not an application error.
 */
async function streamToBufferOrNull(stream: Readable, signal: AbortSignal): Promise<Buffer | null> {
  if (signal.aborted) {
    stream.destroy();
    return null;
  }
  const onAbort = () => stream.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) {
        stream.destroy();
        return null;
      }
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX_FILE_BYTES) {
        // Drain the rest of the stream so the underlying S3 socket releases.
        stream.destroy();
        return null;
      }
      chunks.push(b);
    }
  } catch (err) {
    // A destroy() we issued ourselves surfaces as a premature-close error.
    if (signal.aborted) return null;
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) return null;
  return Buffer.concat(chunks, total);
}

export interface MdatCacheFetcher {
  /**
   * Caller-supplied loader. The caller decides whether to do a full GET
   * (no range) — the cache layer just receives a Readable. The Readable
   * will be fully consumed before this function resolves. `signal` aborts
   * when no request is waiting for the fill any more; pass it to `getObject`.
   */
  (signal: AbortSignal): Promise<Readable>;
}

export interface MdatCacheOptions {
  /**
   * May this call START a fill on a miss? Default true. A request that wants
   * only a small slice passes false: a hit or an already-running fill is
   * still used, but it never pulls the whole zone from the object store.
   */
  allowFill?: boolean;
  /** Aborts THIS caller's wait (client disconnected). */
  signal?: AbortSignal;
}

function startFill(cacheKey: string, fileSize: number, fetcher: MdatCacheFetcher): InflightFill {
  const controller = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inflightBytes = Math.max(0, inflightBytes - fileSize);
    if (inflight.get(cacheKey) === entry) inflight.delete(cacheKey);
  };
  inflightBytes += fileSize;
  const promise = (async (): Promise<Buffer | null> => {
    try {
      const body = await fetcher(controller.signal);
      return await streamToBufferOrNull(body, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return null;
      throw err;
    }
  })()
    .then((buf) => {
      if (buf && !controller.signal.aborted) cache.set(cacheKey, buf);
      return buf;
    })
    .finally(release);
  const entry: InflightFill = { promise, waiters: 0, controller, release };
  inflight.set(cacheKey, entry);
  return entry;
}

function waitForFill(entry: InflightFill, signal?: AbortSignal): Promise<Buffer | null> {
  entry.waiters += 1;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    entry.waiters -= 1;
    if (entry.waiters <= 0) {
      // Nobody is waiting: stop pulling bytes nobody will read. Release the
      // budget now — the socket is being torn down.
      entry.controller.abort();
      entry.release();
    }
  };
  if (!signal) {
    return entry.promise.finally(() => { left = true; entry.waiters -= 1; });
  }
  if (signal.aborted) {
    leave();
    return Promise.resolve(null);
  }
  return new Promise<Buffer | null>((resolve, reject) => {
    const onAbort = () => {
      leave();
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (buf) => {
        signal.removeEventListener('abort', onAbort);
        if (!left) { left = true; entry.waiters -= 1; }
        resolve(buf);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        if (!left) { left = true; entry.waiters -= 1; }
        reject(err);
      },
    );
  });
}

/**
 * Look up the full mdat zone for a (bucket, key, userSalt). On hit, the
 * Buffer is returned (in a microtask). On miss — if `opts.allowFill` is not
 * false and the in-flight budget has room — the fetcher is invoked, its body
 * drained to Buffer, and the result cached if it fits inside `MAX_FILE_BYTES`.
 *
 * Returns `null` when:
 *   - The file is over `MAX_FILE_BYTES` (skip-cache path)
 *   - It is a miss and the caller did not allow a fill, or the in-flight
 *     budget is used up (the caller serves the exact range from S3 instead)
 *   - The caller's `signal` aborted, or the fill was aborted
 *   - The decrypted body exceeded `MAX_FILE_BYTES`
 * A fetcher error rejects.
 *
 * Concurrent misses for the same key share one fetch. The fill is aborted
 * when its last waiter goes away, so a client that disconnects does not
 * leave a whole-zone download running.
 */
export async function getCachedMdat(
  cacheKey: string,
  fileSize: number,
  fetcher: MdatCacheFetcher,
  opts: MdatCacheOptions = {},
): Promise<Buffer | null> {
  if (fileSize > MAX_FILE_BYTES) return null;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = inflight.get(cacheKey);
  if (existing) return waitForFill(existing, opts.signal);

  if (opts.allowFill === false) return null;
  if (opts.signal?.aborted) return null;
  if (inflightBytes + fileSize > MAX_INFLIGHT_BYTES) return null;

  return waitForFill(startFill(cacheKey, fileSize, fetcher), opts.signal);
}

/** Test-only — clear the LRU and any in-flight bookkeeping. */
export function _resetMdatCacheForTests(): void {
  cache.clear();
  for (const e of inflight.values()) e.controller.abort();
  inflight.clear();
  inflightBytes = 0;
}

/** Test-only — bytes currently reserved by running fills. */
export function _getInflightBytesForTests(): number {
  return inflightBytes;
}

/**
 * Salt-agnostic invalidation. The cache key embeds a sha256(salt)[:16]
 * suffix, but a generic `deleteObject(bucket, key)` doesn't have the
 * caller's salt at hand. Iterating the LRU keyspace once per delete is
 * cheap (the cache is bounded by `MAX_BYTES` so worst-case it holds tens
 * of entries), and the alternative — propagating the salt all the way
 * down to `s3.deleteObject` — would force a breaking change on every
 * delete-flow caller (userDeletionWorker, storageReconciler, etc.) for
 * a follow-up to the wedge fix. Returns the number of entries evicted
 * so the caller can log the impact if useful.
 *
 * In practice each (bucket, key) pair has at most one cached entry — a
 * single user owns each key (route-level `resolveS3Path` scopes by
 * userUuid) — but the loop handles the multi-owner edge case defensively
 * for free.
 */
export function invalidateMdatByBucketKey(bucket: string, key: string): number {
  const prefix = `${bucket}:${key}:`;
  let count = 0;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      count += 1;
    }
  }
  return count;
}
