/**
 * Integration test: per-device sessions (`user_sessions`).
 *
 * Signing out on one device ends that device's session and leaves the others
 * signed in; bumping token_generation still ends them all.
 *
 * Real Postgres only. Set DATABASE_URL (CI does); the suite skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import {
  createSession,
  rotateRefreshSession,
  revokeSession,
  getSessionAuthState,
  deleteExpiredSessions,
} from './db/queries/sessions.js';
import { bumpTokenGeneration } from './db/queries/users.js';
import { __setPoolForTest } from './db/index.js';
import { story } from './testing/story.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('user_sessions', () => {
  const SCHEMA = `klipgard_sessions_test_${Date.now()}`;
  let admin: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_URL!, max: 4, connectionTimeoutMillis: 5_000 });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { client = await admin.connect(); lastErr = undefined; break; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1_000)); }
    }
    if (lastErr) throw lastErr;

    await client!.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    // Minimal schema — only the columns the session queries touch.
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        token_generation INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.query(`
      CREATE TABLE user_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        refresh_seq INTEGER NOT NULL DEFAULT 0
      )
    `);

    // revokeSession also drops the device's push registrations.
    await client.query(`
      CREATE TABLE push_devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT
      )
    `);

    __setPoolForTest(admin);
    admin.on('connect', c => {
      c.query(`SET search_path TO "${SCHEMA}", public`).catch(() => { /* ignore */ });
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try { await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`); } catch { /* ignore */ }
      client.release();
    }
    if (admin) await admin.end();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await client.query('TRUNCATE users, user_sessions, push_devices RESTART IDENTITY CASCADE');
  });

  async function seedUser(): Promise<number> {
    const u = await client.query(`INSERT INTO users (token_generation) VALUES (0) RETURNING id`);
    return u.rows[0].id as number;
  }

  it('signing out one device leaves the other signed in', async (ctx) => {
    story(ctx, 'Wylogowanie laptopa kończy tylko jego sesję — telefon tego samego konta dalej działa i dalej się odświeża.');
    const userId = await seedUser();
    const laptop = await createSession(userId);
    const phone = await createSession(userId);
    expect(laptop).not.toBe(phone);

    expect(await revokeSession(laptop, userId)).toBe(true);

    expect(await getSessionAuthState(userId, laptop)).toEqual({ tokenGeneration: 0, sessionActive: false });
    expect(await getSessionAuthState(userId, phone)).toEqual({ tokenGeneration: 0, sessionActive: true });
    expect(await rotateRefreshSession(laptop, userId, 0)).toEqual({ kind: 'gone' });
    expect(await rotateRefreshSession(phone, userId, 0)).toEqual({ kind: 'rotated', seq: 1 });
    // A second sign-out of the same device is a no-op.
    expect(await revokeSession(laptop, userId)).toBe(false);
  });

  it('a session cannot be used or ended under another account', async (ctx) => {
    story(ctx, 'Identyfikator sesji jednego konta nic nie znaczy dla innego — ani jej nie odświeży, ani nie wyloguje cudzego urządzenia.');
    const alice = await seedUser();
    const bob = await seedUser();
    const aliceSession = await createSession(alice);

    expect((await getSessionAuthState(bob, aliceSession)).sessionActive).toBe(false);
    expect(await rotateRefreshSession(aliceSession, bob, 0)).toEqual({ kind: 'gone' });
    expect(await revokeSession(aliceSession, bob)).toBe(false);
    expect((await getSessionAuthState(alice, aliceSession)).sessionActive).toBe(true);
  });

  it('a sign-out everywhere is visible through the generation', async (ctx) => {
    story(ctx, 'Po „wyloguj wszędzie” generacja tokenów rośnie, więc tokeny każdej sesji przestają pasować, choć wiersze sesji zostają.');
    const userId = await seedUser();
    const s = await createSession(userId);
    await bumpTokenGeneration(userId);
    expect(await getSessionAuthState(userId, s)).toEqual({ tokenGeneration: 1, sessionActive: true });
  });

  it('reports an unknown user as generation -1', async () => {
    expect(await getSessionAuthState(999, 'nope')).toEqual({ tokenGeneration: -1, sessionActive: false });
  });

  it('a refresh extends the session and the sweep deletes only expired ones', async (ctx) => {
    story(ctx, 'Sesja żyje tak długo jak refresh token: każde odświeżenie ją przedłuża, a wygasłe (także wylogowane) sprząta cykliczny sweep.');
    const userId = await seedUser();
    const live = await createSession(userId);
    const stale = await createSession(userId);
    await client.query(`UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [stale]);

    expect(await rotateRefreshSession(stale, userId, 0)).toEqual({ kind: 'gone' });
    const before = (await client.query(`SELECT expires_at FROM user_sessions WHERE id=$1`, [live])).rows[0].expires_at as Date;
    await new Promise(r => setTimeout(r, 20));
    expect(await rotateRefreshSession(live, userId, 0)).toEqual({ kind: 'rotated', seq: 1 });
    const after = (await client.query(`SELECT expires_at FROM user_sessions WHERE id=$1`, [live])).rows[0].expires_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    expect(await deleteExpiredSessions()).toBe(1);
    const left = await client.query(`SELECT id FROM user_sessions`);
    expect(left.rows.map(r => r.id)).toEqual([live]);
  });

  describe('[API-CORE-063] refresh reuse detection', () => {
    async function pushDevice(userId: number, sessionId: string) {
      await client.query(`INSERT INTO push_devices (user_id, session_id) VALUES ($1, $2)`, [userId, sessionId]);
    }
    const ageRotation = (id: string, seconds: number) =>
      client.query(`UPDATE user_sessions SET last_used_at = NOW() - make_interval(secs => $2) WHERE id = $1`, [id, seconds]);

    it('[API-CORE-063] each refresh moves the chain one position up', async (ctx) => {
      story(ctx, 'Każde odświeżenie sesji podnosi pozycję jej refresh tokenu o jeden i przesuwa wygaśnięcie.');
      const userId = await seedUser();
      const sid = await createSession(userId);
      expect(await rotateRefreshSession(sid, userId, 0)).toEqual({ kind: 'rotated', seq: 1 });
      expect(await rotateRefreshSession(sid, userId, 1)).toEqual({ kind: 'rotated', seq: 2 });
      const row = (await client.query(`SELECT refresh_seq FROM user_sessions WHERE id=$1`, [sid])).rows[0];
      expect(row.refresh_seq).toBe(2);
    });

    it('[API-CORE-063] a replaced token inside the grace window is a repeat and changes nothing', async (ctx) => {
      story(ctx, 'Dwa równoległe odświeżenia tym samym tokenem: pierwsze obraca łańcuch, drugie (w oknie karencji) dostaje bieżącą pozycję i sesja żyje dalej.');
      const userId = await seedUser();
      const sid = await createSession(userId);
      const [a, b] = await Promise.all([
        rotateRefreshSession(sid, userId, 0),
        rotateRefreshSession(sid, userId, 0),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['grace', 'rotated']);
      expect(a).toMatchObject({ seq: 1 });
      expect(b).toMatchObject({ seq: 1 });
      expect((await getSessionAuthState(userId, sid)).sessionActive).toBe(true);
      expect((await client.query(`SELECT refresh_seq FROM user_sessions WHERE id=$1`, [sid])).rows[0].refresh_seq).toBe(1);
    });

    it('[API-CORE-063] a replaced token after the grace window revokes the session and its push registrations', async (ctx) => {
      story(ctx, 'Zastąpiony token użyty po oknie karencji unieważnia sesję (i jej rejestracje push), ale nie ruszają się inne sesje tego konta.');
      const userId = await seedUser();
      const stolen = await createSession(userId);
      const other = await createSession(userId);
      await pushDevice(userId, stolen);
      await pushDevice(userId, other);
      expect(await rotateRefreshSession(stolen, userId, 0)).toEqual({ kind: 'rotated', seq: 1 });
      await ageRotation(stolen, 3600);

      expect(await rotateRefreshSession(stolen, userId, 0)).toEqual({ kind: 'reused' });

      expect((await getSessionAuthState(userId, stolen)).sessionActive).toBe(false);
      // The thief's token and the owner's current token both stop working.
      expect(await rotateRefreshSession(stolen, userId, 1)).toEqual({ kind: 'gone' });
      expect((await getSessionAuthState(userId, other)).sessionActive).toBe(true);
      const left = await client.query(`SELECT session_id FROM push_devices`);
      expect(left.rows.map(r => r.session_id)).toEqual([other]);
    });

    it('[API-CORE-063] a token two positions behind is a reuse even inside the grace window', async (ctx) => {
      story(ctx, 'Tylko token o jedną pozycję wstecz łapie karencja; token starszy o dwie pozycje to już powtórka, więc kończy sesję.');
      const userId = await seedUser();
      const sid = await createSession(userId);
      await rotateRefreshSession(sid, userId, 0);
      await rotateRefreshSession(sid, userId, 1);
      expect(await rotateRefreshSession(sid, userId, 0)).toEqual({ kind: 'reused' });
      expect((await getSessionAuthState(userId, sid)).sessionActive).toBe(false);
    });
  });
});
