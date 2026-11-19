import crypto from 'crypto';
import { CONFIG } from '../config.js';

/**
 * SSE-C key generation of a bucket (DATA-102, DATA-146). Generation 1 is the
 * original derivation. Generation 2 has its own HKDF info and may have its own
 * master key. The generation is a pure function of the bucket name, so the
 * database stores nothing about it.
 */
export type KeyGeneration = 1 | 2;

/**
 * HKDF info of generation 1. Part of the stored-data format: changing these
 * bytes makes every existing generation-1 object unreadable.
 */
const SSE_C_KDF_INFO = Buffer.from('klipgard-sse-c-v1', 'utf-8');

/** HKDF info of generation 2. Part of the stored-data format, like the one above. */
const SSE_C_KDF_INFO_V2 = Buffer.from('klipgard-sse-c-v2', 'utf-8');

/**
 * Derive a 32-byte SSE-C encryption key for a user using HKDF-SHA256.
 *
 * The master key (from env) is combined with the user's unique salt (from DB)
 * to produce a deterministic, per-user key. The object store uses this key to
 * encrypt/decrypt objects transparently via SSE-C headers.
 *
 * `generation` only picks the HKDF info. The caller passes the master key of
 * that generation (`masterKeyForGeneration`). Generation 1 is the default.
 *
 * Security properties:
 * - Different salts → different keys (per-user isolation)
 * - Master key alone is not enough (need salt from DB)
 * - Salt alone is not enough (need master key from env)
 * - Deterministic: same inputs always produce same key (no state to track)
 */
export function deriveUserKey(masterKey: string, userSalt: string, generation: KeyGeneration = 1): Buffer {
  if (!masterKey) throw new Error('Encryption master key is required');
  if (!userSalt) throw new Error('User encryption salt is required');
  if (generation !== 1 && generation !== 2) throw new Error(`Unknown SSE-C key generation ${String(generation)}`);

  const ikm = Buffer.from(masterKey, 'utf-8');
  const salt = Buffer.from(userSalt, 'base64url');
  const info = generation === 2 ? SSE_C_KDF_INFO_V2 : SSE_C_KDF_INFO;

  const derived = crypto.hkdfSync('sha256', ikm, salt, info, 32);
  return Buffer.from(derived);
}

/** The key material that decides the SSE-C key of an object in a bucket. */
export interface SseKeyConfig {
  /** `KLIPGARD_ENCRYPTION_MASTER_KEY`. */
  masterKey: string;
  /** `KLIPGARD_ENCRYPTION_MASTER_KEY_V2`. Empty or unset: generation 2 uses `masterKey`. */
  masterKeyV2?: string;
  /** `KLIPGARD_SSE_V2_BUCKETS`. Empty or unset: every bucket is generation 1. */
  v2Buckets?: readonly string[];
}

/** The key material of this process, from the environment. */
export function sseKeyConfig(): SseKeyConfig {
  return {
    masterKey: CONFIG.encryptionMasterKey,
    masterKeyV2: CONFIG.encryptionMasterKeyV2,
    v2Buckets: CONFIG.sseV2Buckets,
  };
}

/**
 * The key generation of the objects in `bucket`: 2 if the bucket is listed in
 * `KLIPGARD_SSE_V2_BUCKETS`, else 1. The match is exact.
 */
export function keyGenerationForBucket(bucket: string, v2Buckets: readonly string[] = CONFIG.sseV2Buckets ?? []): KeyGeneration {
  return v2Buckets.includes(bucket) ? 2 : 1;
}

/** The master key of a generation. Generation 2 falls back to the generation-1 key. */
export function masterKeyForGeneration(generation: KeyGeneration, keys: SseKeyConfig = sseKeyConfig()): string {
  if (generation === 2 && keys.masterKeyV2) return keys.masterKeyV2;
  return keys.masterKey;
}

/** The SSE-C key of a user's objects in `bucket`, in the generation of that bucket. */
export function deriveBucketUserKey(bucket: string, userSalt: string, keys: SseKeyConfig = sseKeyConfig()): Buffer {
  const generation = keyGenerationForBucket(bucket, keys.v2Buckets ?? []);
  return deriveUserKey(masterKeyForGeneration(generation, keys), userSalt, generation);
}

/**
 * Compute SSE-C headers required by S3/MinIO for encrypted operations.
 *
 * Returns the three headers needed on every PUT/GET/HEAD/COPY:
 * - Algorithm: always AES256
 * - Key: base64-encoded 32-byte derived key
 * - Key MD5: base64-encoded MD5 of the key (for integrity verification)
 */
export function ssecHeaders(userKey: Buffer): {
  SSECustomerAlgorithm: 'AES256';
  SSECustomerKey: string;
  SSECustomerKeyMD5: string;
} {
  const keyBase64 = userKey.toString('base64');
  const keyMd5 = crypto.createHash('md5').update(userKey).digest('base64');
  return {
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: keyBase64,
    SSECustomerKeyMD5: keyMd5,
  };
}
