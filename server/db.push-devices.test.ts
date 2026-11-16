/**
 * Integration test: push devices are bound to the session + token generation
 * they were registered under, so a revoked sign-in stops receiving pushes.
 *
 * Real Postgres only (scratch DB with the migrator applied); skips without a URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { __setPoolForTest } from './db/index.js';
import { createScratchDb, testDbBaseUrl, type ScratchDb } from './testing/scratch-db.js';
import { createSession, revokeSession } from './db/queries/sessions.js';
import { bumpTokenGeneration } from './db/queries/users.js';
import {
  upsertPushDevice,
  upsertRelayPushDevice,
  getPushDevicesForUser,
  ownsRelayDevice,
} from './db/queries/push.js';
import { story } from './testing/story.js';

describe.skipIf(!testDbBaseUrl())('push_devices session binding', () => {
  let scratch: ScratchDb;
  let userId: number;

  beforeAll(async () => {
    scratch = await createScratchDb();
    __setPoolForTest(scratch.pool);
    const { rows } = await scratch.pool.query<{ id: number }>(
      `INSERT INTO users (uuid, email) VALUES (gen_random_uuid(), 'push-bind@example.test') RETURNING id`,
    );
    userId = rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  }, 60_000);

  const tokens = async () => (await getPushDevicesForUser(userId)).map((d) => d.deviceToken).sort();
  const generation = async () =>
    (await scratch.pool.query<{ g: number }>(`SELECT token_generation AS g FROM users WHERE id=$1`, [userId])).rows[0].g;

  it('a device registered before sign-out everywhere gets no more pushes', async (ctx) => {
    story(ctx, 'Po „wyloguj wszędzie” zgubiony telefon przestaje dostawać powiadomienia o nagraniach.');
    const a = await createSession(userId);
    await upsertPushDevice({ userId, deviceToken: 't-all', platform: 'ios', sessionId: a, tokenGeneration: await generation() });
    expect(await tokens()).toEqual(['t-all']);
    await bumpTokenGeneration(userId);
    expect(await getPushDevicesForUser(userId)).toEqual([]);
  });

  it('re-registering after signing in again restores pushes', async (ctx) => {
    story(ctx, 'Po ponownym zalogowaniu aplikacja rejestruje się na nowo i powiadomienia wracają.');
    const b = await createSession(userId);
    await upsertPushDevice({ userId, deviceToken: 't-all', platform: 'ios', sessionId: b, tokenGeneration: await generation() });
    expect(await tokens()).toContain('t-all');
  });

  it('signing one device out stops only its pushes', async (ctx) => {
    story(ctx, 'Wylogowanie jednego urządzenia kończy powiadomienia na nim, a drugie urządzenie dalej je dostaje.');
    const sa = await createSession(userId);
    const sb = await createSession(userId);
    const g = await generation();
    await upsertPushDevice({ userId, deviceToken: 'dev-a', platform: 'ios', sessionId: sa, tokenGeneration: g });
    await upsertPushDevice({ userId, deviceToken: 'dev-b', platform: 'android', sessionId: sb, tokenGeneration: g });
    await revokeSession(sa, userId);
    const t = await tokens();
    expect(t).toContain('dev-b');
    expect(t).not.toContain('dev-a');
    const { rows } = await scratch.pool.query(`SELECT 1 FROM push_devices WHERE device_token='dev-a'`);
    expect(rows).toHaveLength(0);
  });

  it('a revoked session filters a row even if the row was not deleted', async (ctx) => {
    story(ctx, 'Nawet gdy wiersz urządzenia przetrwał (wyścig z rejestracją), unieważniona sesja nie dostaje powiadomień.');
    const s = await createSession(userId);
    await upsertPushDevice({ userId, deviceToken: 'dev-race', platform: 'ios', sessionId: s, tokenGeneration: await generation() });
    await scratch.pool.query(`UPDATE user_sessions SET revoked_at = now() WHERE id=$1`, [s]);
    expect(await tokens()).not.toContain('dev-race');
  });

  it('a row from before the binding keeps getting pushes until the next revocation', async (ctx) => {
    story(ctx, 'Urządzenie zarejestrowane przed zmianą (bez sesji i generacji) dostaje powiadomienia, żeby wdrożenie nikomu ich nie ucięło.');
    await scratch.pool.query(
      `INSERT INTO push_devices (user_id, device_token, platform) VALUES ($1, 'legacy', 'ios')`, [userId]);
    expect(await tokens()).toContain('legacy');
    await bumpTokenGeneration(userId);
    expect(await tokens()).toContain('legacy');
  });

  it('a relay device keeps its id after the generation moves on', async (ctx) => {
    story(ctx, 'Urządzenie przez przekaźnik zachowuje swój identyfikator po zmianie generacji, więc ponowna rejestracja nie tworzy nowego.');
    const s = await createSession(userId);
    const g = await generation();
    await upsertRelayPushDevice({ userId, relayDeviceId: 'r-1', publicKey: 'k', platform: 'ios', sessionId: s, tokenGeneration: g });
    await bumpTokenGeneration(userId);
    expect((await getPushDevicesForUser(userId)).some((d) => d.relay?.deviceId === 'r-1')).toBe(false);
    expect(await ownsRelayDevice(userId, 'r-1')).toBe(true);
    expect(await ownsRelayDevice(userId + 999, 'r-1')).toBe(false);
  });

  it('registering without an explicit generation stamps the current one', async (ctx) => {
    story(ctx, 'Rejestracja z tokenem sprzed wprowadzenia generacji dostaje bieżącą generację konta.');
    await upsertPushDevice({ userId, deviceToken: 'dev-nogen', platform: 'ios' });
    const { rows } = await scratch.pool.query<{ g: number }>(`SELECT token_generation AS g FROM push_devices WHERE device_token='dev-nogen'`);
    expect(rows[0].g).toBe(await generation());
  });
});
