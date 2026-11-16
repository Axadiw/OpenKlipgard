/**
 * DB-level test for getReadyFilesBeforeAfterId, the scan query of the
 * `rebuild-old-sidecars` script ([WORKER-086], [WORKER-089]).
 *
 * Real Postgres only: set DATABASE_URL_TEST or DATABASE_URL, otherwise the
 * suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { createScratchDb, type ScratchDb } from '../../testing/scratch-db.js';
import { story } from '../../testing/story.js';
import { __setPoolForTest } from '../index.js';
import { getReadyFilesBeforeAfterId } from './events.js';

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('getReadyFilesBeforeAfterId [WORKER-086]', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let ownerId: number;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 2 });
    pool = scratch.pool;
    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes)
       VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`,
    );
    __setPoolForTest(pool);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE file_metadata, users RESTART IDENTITY CASCADE`);
    const u = await pool.query<{ id: number }>(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'sidecar-scan@example.com', 'x', true, true, 1)
       RETURNING id`,
    );
    ownerId = u.rows[0].id;
  }, 60_000);

  async function addFile(name: string, state: string, uploadedAt: string): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state, uploaded_at)
       VALUES ($1, 'recordings', $2, $2, 1000, $3, $4) RETURNING id`,
      [ownerId, `u/${name}.mp4`, state, uploadedAt],
    );
    return r.rows[0].id;
  }

  it('[WORKER-086] returns only ready recordings uploaded before the cutoff, in id order', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'The scan sees old ready recordings only and never a pending, unplayable or recent one.');
    const a = await addFile('a', 'ready', '2026-04-01T00:00:00Z');
    await addFile('pending', 'pending_sidecar', '2026-04-01T00:00:00Z');
    await addFile('unplayable', 'unplayable', '2026-04-01T00:00:00Z');
    await addFile('recent', 'ready', '2026-06-01T00:00:00Z');
    const b = await addFile('b', 'ready', '2026-05-15T23:59:59Z');

    const rows = await getReadyFilesBeforeAfterId(0, new Date('2026-05-16T00:00:00Z'), 200);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows[0]).toMatchObject({ s3Bucket: 'recordings', s3Key: 'u/a.mp4' });
    expect(rows[0].encryptionSalt).not.toBeUndefined();
  });

  it('[WORKER-089] the cursor and the limit page through the rows without a repeat', { timeout: 30_000 }, async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addFile(`f${i}`, 'ready', '2026-04-01T00:00:00Z'));
    const cutoff = new Date('2026-05-16T00:00:00Z');

    const p1 = await getReadyFilesBeforeAfterId(0, cutoff, 2);
    const p2 = await getReadyFilesBeforeAfterId(p1[p1.length - 1].id, cutoff, 2);
    const p3 = await getReadyFilesBeforeAfterId(p2[p2.length - 1].id, cutoff, 2);
    const p4 = await getReadyFilesBeforeAfterId(p3[p3.length - 1].id, cutoff, 2);
    expect([...p1, ...p2, ...p3].map((r) => r.id)).toEqual(ids);
    expect(p4).toEqual([]);
  });
});
