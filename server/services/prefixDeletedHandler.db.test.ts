/**
 * [FTPS-102] The consumer of `stream:ftps-prefix-deleted`, against a scratch
 * database. The object store is a set of keys the test controls.
 *
 *   DATABASE_URL_TEST=... npx vitest run server/services/prefixDeletedHandler.db.test.ts
 *
 * Without a test database the suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createScratchDb, type ScratchDb } from '../testing/scratch-db.js';
import { story } from '../testing/story.js';
import { __setPoolForTest } from '../db/index.js';
import { completeUpload } from './ingest/completeUpload.js';
import { handleDeleteNotify } from './deleteNotifyHandler.js';
import { handlePrefixDeleted, type PrefixDeletedDeps } from './prefixDeletedHandler.js';
import {
  getFileMetadataKeysUnderPrefix,
  getViewPathsUnderPrefix,
} from '../db/queries/events.js';

const { mockDeleteSidecars, mockDeleteThumb } = vi.hoisted(() => ({
  mockDeleteSidecars: vi.fn(),
  mockDeleteThumb: vi.fn(),
}));
vi.mock('./streamsClient.js', () => ({ publishThumbnailUnique: vi.fn().mockResolvedValue('published') }));
vi.mock('./fileLifecycle.js', () => ({
  deleteSidecarsForRecording: (...a: unknown[]) => mockDeleteSidecars(...a),
}));
vi.mock('./eventCleanup.js', () => ({
  deleteGeneratedThumbnail: (...a: unknown[]) => mockDeleteThumb(...a),
}));

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('FTPS-102 prefix-deleted consumer (DB)', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let userId: number;
  let userUuid: string;
  let otherUuid: string;

  const BUCKET = 'recordings';
  const keyOf = (rel: string) => `${userUuid}/${rel}`;
  const up = (rel: string, name: string, size = 1000) =>
    completeUpload({ userId, userUuid, s3Bucket: BUCKET, s3Key: keyOf(rel), originalFilename: name, fileSizeBytes: size });

  /** Dependencies on the real queries and the real delete-notify handler. */
  const deps = (live: string[] = []): PrefixDeletedDeps => ({
    ownerIdOf: async (u) => (u === userUuid ? userId : null),
    fileKeys: getFileMetadataKeysUnderPrefix,
    viewPaths: getViewPathsUnderPrefix,
    liveKeys: async () => new Set(live),
    deleteNotify: handleDeleteNotify,
  });
  const count = async (sql: string) => (await pool.query<{ c: number }>(sql, [userId])).rows[0].c;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 10 });
    pool = scratch.pool;
    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes)
       VALUES (1, 'free', 1000000000, 1000000000) ON CONFLICT DO NOTHING`,
    );
    __setPoolForTest(pool);
  }, 120_000);

  afterAll(async () => { await scratch?.drop(); }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDeleteSidecars.mockResolvedValue(0);
    mockDeleteThumb.mockResolvedValue(undefined);
    await pool.query(`TRUNCATE event_view_files, events, file_metadata, notifications, users RESTART IDENTITY CASCADE`);
    const u = await pool.query<{ id: number; uuid: string }>(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, camera_profile_mode)
       VALUES (gen_random_uuid(), 'pd-test@example.com', 'x', true, true, 1, 'auto')
       RETURNING id, uuid`,
    );
    userId = u.rows[0].id;
    userUuid = u.rows[0].uuid;
    otherUuid = (await pool.query<{ u: string }>(`SELECT gen_random_uuid()::text AS u`)).rows[0].u;
  }, 60_000);

  async function seed() {
    await up('2026/06/12/Driveway_00_20260612121935.mp4', 'Driveway_00_20260612121935.mp4');
    await up('2026/06/12/Back_00_20260612130000.mp4', 'Back_00_20260612130000.mp4');
    await up('2026/06/13/Driveway_00_20260613121935.mp4', 'Driveway_00_20260613121935.mp4');
  }

  it('FTPS-102: sweeps the records under the prefix, and only under it', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Po usunięciu katalogu 2026/06/12 przez FTP wiersze file_metadata i eventy z tego katalogu znikają od razu; katalog obok zostaje nietknięty.');
    await seed();
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(3);

    const swept = await handlePrefixDeleted({ userUuid, prefix: `${userUuid}/2026/06/12` }, deps());

    expect(swept).toBe(2);
    const { rows } = await pool.query<{ s3_key: string }>(`SELECT s3_key FROM file_metadata WHERE owner_id = $1`, [userId]);
    expect(rows.map(r => r.s3_key)).toEqual([keyOf('2026/06/13/Driveway_00_20260613121935.mp4')]);
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS c FROM event_view_files v JOIN events e ON e.id = v.event_id WHERE e.owner_id = $1`)).toBe(1);
    // Sidecars of the swept recordings go through the shared helper.
    expect(mockDeleteSidecars).toHaveBeenCalledWith(keyOf('2026/06/12/Driveway_00_20260612121935.mp4'));
    expect(mockDeleteSidecars).toHaveBeenCalledWith(keyOf('2026/06/12/Back_00_20260612130000.mp4'));
  });

  it('FTPS-102: a second run over the same prefix is a no-op', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'FTPS wysyła per-plikowe delete-notify ORAZ prefix-deleted, więc konsument musi być idempotentny: drugi przebieg po wyczyszczonych kluczach nic nie robi.');
    await seed();
    const msg = { userUuid, prefix: `${userUuid}/2026/06/12` };
    await handlePrefixDeleted(msg, deps());
    mockDeleteSidecars.mockClear();

    const again = await handlePrefixDeleted(msg, deps());

    expect(again).toBe(0);
    expect(mockDeleteSidecars).not.toHaveBeenCalled();
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(1);
  });

  it('FTPS-102: records whose file row is already gone are still swept through the event views', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Per-plikowy delete-notify skasował wiersz file_metadata, ale zginął przed usunięciem widoku: prefix-deleted znajduje widok po ścieżce i usuwa event.');
    await seed();
    await pool.query(`DELETE FROM file_metadata WHERE owner_id = $1 AND starts_with(s3_key, $2)`, [userId, keyOf('2026/06/12/')]);

    const swept = await handlePrefixDeleted({ userUuid, prefix: `${userUuid}/2026/06/12/` }, deps());

    expect(swept).toBe(2);
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(1);
  });

  it('FTPS-102: an object that exists again under the prefix keeps its records', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Kamera zdążyła wgrać plik do katalogu po jego usunięciu, zanim konsument przeczytał wiadomość: ten plik zostaje z wierszem i eventem.');
    await seed();
    const live = keyOf('2026/06/12/Back_00_20260612130000.mp4');

    const swept = await handlePrefixDeleted({ userUuid, prefix: `${userUuid}/2026/06/12` }, deps([live]));

    expect(swept).toBe(1);
    const { rows } = await pool.query<{ s3_key: string }>(`SELECT s3_key FROM file_metadata WHERE owner_id = $1 ORDER BY s3_key`, [userId]);
    expect(rows.map(r => r.s3_key)).toContain(live);
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(2);
  });

  it('FTPS-102: a prefix matches a whole directory name, not the start of a longer one', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Prefiks 2026/06/1 nie obejmuje katalogu 2026/06/12: dopasowanie jest do pełnej nazwy katalogu.');
    await seed();

    const swept = await handlePrefixDeleted({ userUuid, prefix: `${userUuid}/2026/06/1` }, deps());

    expect(swept).toBe(0);
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(3);
  });

  it('FTPS-102: a prefix outside the account of the message is ignored', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Wiadomość nie może zamiatać rekordów spoza konta, które wskazuje: prefiks innego konta kończy obsługę bez zmian.');
    await seed();

    const swept = await handlePrefixDeleted({ userUuid, prefix: `${otherUuid}/2026/06/12` }, deps());

    expect(swept).toBe(0);
    expect(await count(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`)).toBe(3);
  });
});
