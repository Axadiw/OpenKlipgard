import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  deriveUserKey, ssecHeaders, keyGenerationForBucket, masterKeyForGeneration, deriveBucketUserKey,
} from './encryption.js';
import { sseV2BucketsFromEnv } from '../config.js';
import { story } from '../testing/story.js';

// Fixed vectors. Generation 1 was computed with the code from BEFORE key
// generations existed (`deriveUserKey(master, salt)` on master), so it pins the
// stored-data format: every existing object was written with this derivation.
// The same vectors are asserted in ftps-server/src/encryption.rs.
const VECTOR_MASTER = 'klipgard-test-master-key-0123456789abcdef';
const VECTOR_MASTER_V2 = 'klipgard-second-master-key-fedcba9876543210';
const VECTOR_SALT = 'Zml4ZWQtc2FsdC1mb3ItdGhlLWtub3duLXZlY3Rvcg'; // base64url('fixed-salt-for-the-known-vector')
const GEN1_HEX = 'a45c5bd43c73c92c2fb410f5eae48b366f4bd1583391fba69dded53f4be9728a';
const GEN1_MD5 = 'X0s/K87M+2N0JGhwnP9iJQ==';
const GEN2_HEX = '7bdfd2c6c6dbf23763b7abb2a0718d5669602a56d7ba1cc80b7ca392a8a34403';
const GEN2_MD5 = 'wxBF2et9TLlzDZwiywCt0w==';
const GEN2_OWN_MASTER_HEX = '611cfcc3d72613b48ab23f9a4a470585f1db1cb1b29f55f983a0675edf6b6aa6';

describe('SSE-C key generations', () => {
  it('generation 1 is byte for byte the original derivation', (ctx) => {
    story(ctx, '[DATA-102] Generacja 1 daje dokładnie ten sam klucz co kod sprzed wprowadzenia generacji — wektor policzony starym kodem. Każda zmiana tu oznacza, że żadne istniejące nagranie nie da się odczytać.');
    expect(deriveUserKey(VECTOR_MASTER, VECTOR_SALT).toString('hex')).toBe(GEN1_HEX);
    expect(deriveUserKey(VECTOR_MASTER, VECTOR_SALT, 1).toString('hex')).toBe(GEN1_HEX);
    expect(ssecHeaders(deriveUserKey(VECTOR_MASTER, VECTOR_SALT, 1)).SSECustomerKeyMD5).toBe(GEN1_MD5);
    // The vector the Rust FTPS server has asserted all along.
    expect(deriveUserKey('testkey', 'dGVzdHNhbHQ').toString('hex')).toBe('d1ffb4baebfbfcbd72477c9779c30efce44c565ecfd0b38c0a0dde7bcc9f6b6b');
  });

  it('generation 2 is a different key, equal to the vectors the FTPS server asserts', (ctx) => {
    story(ctx, '[DATA-146] Generacja 2 (info "klipgard-sse-c-v2") daje inny klucz niż generacja 1 i ten sam co serwer FTPS w Rust — kopia do nowego bucketu jest naprawdę przeszyfrowana, a FTPS i API się rozumieją.');
    const gen2 = deriveUserKey(VECTOR_MASTER, VECTOR_SALT, 2);
    expect(gen2.toString('hex')).toBe(GEN2_HEX);
    expect(gen2.toString('hex')).not.toBe(GEN1_HEX);
    expect(ssecHeaders(gen2).SSECustomerKeyMD5).toBe(GEN2_MD5);
    expect(deriveUserKey('testkey', 'dGVzdHNhbHQ', 2).toString('hex')).toBe('fdff82620ba4a596c31b1bbacb24d761d67950113f423b2a3dfab87a91fd1196');
    expect(deriveUserKey(VECTOR_MASTER_V2, VECTOR_SALT, 2).toString('hex')).toBe(GEN2_OWN_MASTER_HEX);
  });

  it('refuses an unknown generation', (ctx) => {
    story(ctx, 'Nieznana generacja to błąd, a nie cichy powrót do generacji 1 — inaczej zapis poszedłby złym kluczem.');
    expect(() => deriveUserKey(VECTOR_MASTER, VECTOR_SALT, 3 as never)).toThrow('generation');
  });

  it('the bucket name picks the generation, and no list means generation 1', (ctx) => {
    story(ctx, '[DATA-146] Generacja to czysta funkcja nazwy bucketu. Bez KLIPGARD_SSE_V2_BUCKETS (domyślnie) każdy bucket jest w generacji 1, więc dla istniejących danych nic się nie zmienia.');
    expect(keyGenerationForBucket('recordings', [])).toBe(1);
    expect(keyGenerationForBucket('recordings')).toBe(1); // this process: the variable is not set in tests
    expect(keyGenerationForBucket('new-recordings', ['new-recordings', 'new-thumbs'])).toBe(2);
    expect(keyGenerationForBucket('recordings', ['new-recordings'])).toBe(1);
    expect(keyGenerationForBucket('new-recordings-x', ['new-recordings'])).toBe(1);
  });

  it('parses KLIPGARD_SSE_V2_BUCKETS as a comma-separated list, empty by default', (ctx) => {
    story(ctx, '[DATA-146] Lista bucketów generacji 2 to nazwy rozdzielone przecinkami; pusta lub nieustawiona oznacza brak takich bucketów.');
    expect(sseV2BucketsFromEnv({})).toEqual([]);
    expect(sseV2BucketsFromEnv({ KLIPGARD_SSE_V2_BUCKETS: '' })).toEqual([]);
    expect(sseV2BucketsFromEnv({ KLIPGARD_SSE_V2_BUCKETS: ' , ' })).toEqual([]);
    expect(sseV2BucketsFromEnv({ KLIPGARD_SSE_V2_BUCKETS: 'a, b ,,c' })).toEqual(['a', 'b', 'c']);
  });

  it('generation 2 uses its own master key when set, else the first one', (ctx) => {
    story(ctx, '[DATA-146] Generacja 2 bierze KLIPGARD_ENCRYPTION_MASTER_KEY_V2, a gdy go brak — dotychczasowy master key. Generacja 1 zawsze bierze dotychczasowy.');
    expect(masterKeyForGeneration(1, { masterKey: 'm1', masterKeyV2: 'm2' })).toBe('m1');
    expect(masterKeyForGeneration(2, { masterKey: 'm1', masterKeyV2: 'm2' })).toBe('m2');
    expect(masterKeyForGeneration(2, { masterKey: 'm1', masterKeyV2: '' })).toBe('m1');
    expect(masterKeyForGeneration(2, { masterKey: 'm1' })).toBe('m1');
  });

  it('derives the key of a bucket from its generation and that generation\'s master key', (ctx) => {
    story(ctx, '[DATA-146] Klucz obiektu = sól właściciela + generacja bucketu + master key tej generacji. Bucket spoza listy zawsze dostaje dotychczasowy klucz.');
    const keys = { masterKey: VECTOR_MASTER, masterKeyV2: VECTOR_MASTER_V2, v2Buckets: ['new-recordings'] };
    expect(deriveBucketUserKey('recordings', VECTOR_SALT, keys).toString('hex')).toBe(GEN1_HEX);
    expect(deriveBucketUserKey('new-recordings', VECTOR_SALT, keys).toString('hex')).toBe(GEN2_OWN_MASTER_HEX);
    expect(deriveBucketUserKey('new-recordings', VECTOR_SALT, { ...keys, masterKeyV2: undefined }).toString('hex')).toBe(GEN2_HEX);
    expect(deriveBucketUserKey('recordings', VECTOR_SALT, { masterKey: VECTOR_MASTER }).toString('hex')).toBe(GEN1_HEX);
  });
});

describe('deriveUserKey', () => {
  const masterKey = 'test-master-key-for-unit-tests';
  const salt1 = crypto.randomBytes(32).toString('base64url');
  const salt2 = crypto.randomBytes(32).toString('base64url');

  it('returns a 32-byte Buffer', (ctx) => {
    story(ctx, 'Klucz szyfrujący SSE-C musi mieć dokładnie 32 bajty — długość narzucona przez AES-256, bez której S3 odrzuci obiekt.');
    const key = deriveUserKey(masterKey, salt1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('is deterministic (same inputs → same key)', (ctx) => {
    story(ctx, 'Ten sam master key i sól zawsze generują identyczny klucz — warunek konieczny, żeby odszyfrować nagranie zapisane wcześniej tą samą kombinacją.');
    const key1 = deriveUserKey(masterKey, salt1);
    const key2 = deriveUserKey(masterKey, salt1);
    expect(key1.equals(key2)).toBe(true);
  });

  it('different salts produce different keys', (ctx) => {
    story(ctx, 'Każdy user ma własną sól — nawet gdy master key wycieknie częściowo, klucze dla poszczególnych kont pozostają niezależne i nie dają się pomieszać.');
    const key1 = deriveUserKey(masterKey, salt1);
    const key2 = deriveUserKey(masterKey, salt2);
    expect(key1.equals(key2)).toBe(false);
  });

  it('different master keys produce different keys', (ctx) => {
    story(ctx, 'Zmiana master keya (np. przy rotacji sekretów) skutkuje innym kluczem pochodnym — kluczowy warunek, żeby nowe operacje nie kolidowały ze starymi obiektami.');
    const key1 = deriveUserKey('master-key-A', salt1);
    const key2 = deriveUserKey('master-key-B', salt1);
    expect(key1.equals(key2)).toBe(false);
  });

  it('throws if master key is empty', (ctx) => {
    story(ctx, 'Pusty master key musi wywołać błąd — inaczej uruchomiona aplikacja szyfrowałaby nagrania trywialnym kluczem, równoznacznie z brakiem szyfrowania.');
    expect(() => deriveUserKey('', salt1)).toThrow('master key');
  });

  it('throws if salt is empty', (ctx) => {
    story(ctx, 'Brak soli dla usera jest błędem krytycznym — w przeciwnym razie wszystkie konta dostałyby ten sam klucz, co zlikwidowałoby izolację między tenantami.');
    expect(() => deriveUserKey(masterKey, '')).toThrow('salt');
  });
});

describe('ssecHeaders', () => {
  it('returns correct structure', (ctx) => {
    story(ctx, 'Nagłówki SSE-C do S3 muszą mieć poprawne pola (algorithm, key, key-MD5) — to kontrakt z AWS, bez którego PUT/GET się nie powiedzie.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    expect(headers.SSECustomerAlgorithm).toBe('AES256');
    expect(typeof headers.SSECustomerKey).toBe('string');
    expect(typeof headers.SSECustomerKeyMD5).toBe('string');
  });

  it('key is base64-encoded 32 bytes', (ctx) => {
    story(ctx, 'Klucz SSE-C jest base64 z 32-bajtowego bufora — dokładnie taki format wymaga S3 i każda pomyłka zablokowałaby upload/download.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    const decoded = Buffer.from(headers.SSECustomerKey, 'base64');
    expect(decoded.length).toBe(32);
    expect(decoded.equals(key)).toBe(true);
  });

  it('MD5 matches the key', (ctx) => {
    story(ctx, 'S3 sprawdza MD5 klucza SSE-C jako checksum — jeśli nie zgadza się z zawartością, żądanie zostaje odrzucone, więc kalkulacja MD5 musi być zgodna z kluczem.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    const expectedMd5 = crypto.createHash('md5').update(key).digest('base64');
    expect(headers.SSECustomerKeyMD5).toBe(expectedMd5);
  });

  it('same key always produces same headers', (ctx) => {
    story(ctx, 'Dwa wywołania z identycznym kluczem dają identyczne nagłówki — warunek, aby kolejne żądania do tego samego obiektu S3 mogły użyć cache\'u i nie dublowały pracy.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const h1 = ssecHeaders(key);
    const h2 = ssecHeaders(key);
    expect(h1).toEqual(h2);
  });
});
