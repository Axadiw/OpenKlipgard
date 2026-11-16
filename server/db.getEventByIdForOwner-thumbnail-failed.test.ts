/**
 * [API-EVENTS-017] The detail query computes `thumbnailFailed` like the list.
 *
 * Runs against an isolated scratch database (see testing/scratch-db.ts), so it
 * tests the real SQL rather than the query string.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getEventByIdForOwner, THUMBNAIL_UNPLAYABLE } from './db/queries/events.js';
import { __setPoolForTest } from './db/index.js';
import { createScratchDb, type ScratchDb } from './testing/scratch-db.js';
import { story } from './testing/story.js';

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

async function insertEvent(pool: Pool, id: string, ownerId: number, thumbnail: string | null) {
  await pool.query(
    `INSERT INTO events (id, camera, timestamp, date, owner_id, thumbnail, playback_ready, playback_unplayable)
     VALUES ($1, 'cam', '2026-01-01T10:00:00.000Z', '2026-01-01', $2, $3, true, false)`,
    [id, ownerId, thumbnail],
  );
  await pool.query(
    `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
    [id, `${id}.mp4`],
  );
}

describe.skipIf(!TEST_DB_URL)('getEventByIdForOwner thumbnailFailed', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let ownerId: number;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 5 });
    pool = scratch.pool;
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'detail-thumb@example.com', 'x', true, true, 1)
       RETURNING id`,
    );
    ownerId = u.rows[0].id;
    __setPoolForTest(pool);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE events RESTART IDENTITY CASCADE`);
  });

  it('[API-EVENTS-017] is true when the thumbnail is the tombstone', async (ctx) => {
    story(ctx, 'Ekran szczegółów nagrania dostaje flagę thumbnailFailed i może pokazać stan "miniatura niedostępna" bez znajomości wewnętrznego ciągu tombstone.');
    await insertEvent(pool, 'e-tomb', ownerId, THUMBNAIL_UNPLAYABLE);
    const ev = await getEventByIdForOwner('e-tomb', ownerId);
    expect(ev?.thumbnailFailed).toBe(true);
  });

  it('[API-EVENTS-017] is false for a stored thumbnail and for none yet', async (ctx) => {
    story(ctx, 'Zwykła miniatura i brak miniatury (jeszcze nie wygenerowana) nie są błędem: flaga jest fałszywa.');
    await insertEvent(pool, 'e-ok', ownerId, '__s3_thumb__/u/e-ok.jpg');
    await insertEvent(pool, 'e-none', ownerId, null);
    expect((await getEventByIdForOwner('e-ok', ownerId))?.thumbnailFailed).toBe(false);
    expect((await getEventByIdForOwner('e-none', ownerId))?.thumbnailFailed).toBe(false);
  });
});
