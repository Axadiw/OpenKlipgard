import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parse } from 'pg-connection-string';
import { story } from './testing/story.js';
import { databaseUrlFromEnv, cleanFrameEnabledFromEnv, appEnvironmentFromEnv } from './config.js';
import { internalApiKeyFromEnv } from './utils/internalApiKey.js';

/**
 * Every character that is unsafe in the userinfo part of a URL, plus a space.
 * Appended to a random prefix, so no password literal sits in the source.
 */
const URL_UNSAFE = ['/', '+', '=', '@', ':', '%', '?', '#', ' '].join('');

/** The punctuation a URL leaves alone (RFC 3986 unreserved). */
const URL_UNRESERVED = ['-', '_', '.', '~'].join('');

/** What the pg driver will actually connect with. */
function connectionOf(url: string) {
  const p = parse(url);
  return { user: p.user, password: p.password, host: p.host, port: p.port, database: p.database };
}

describe('databaseUrlFromEnv', () => {
  const bare = { DATABASE_URL: 'klipgard-db:5432/klipgard' };

  it('percent-encodes the credentials, so any password survives the URL', (ctx) => {
    story(ctx, 'Hasło bazy jest dowolnym napisem. Znaki /, +, =, @, :, %, ?, # i spacja nie mogą psuć adresu połączenia — wcześniej hasło z „/” (np. z `openssl rand -base64 48`) wywracało API przy starcie z „Invalid URL”.');
    const password = randomBytes(4).toString('hex') + URL_UNSAFE;
    const user = 'klip gard@site';
    const url = databaseUrlFromEnv({ ...bare, POSTGRES_USER: user, POSTGRES_PASSWORD: password });
    expect(connectionOf(url)).toEqual({ user, password, host: 'klipgard-db', port: '5432', database: 'klipgard' });
  });

  it('round-trips every base64 secret through the parser pg uses', () => {
    for (let i = 0; i < 500; i++) {
      const password = randomBytes(48).toString('base64');
      const url = databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: password });
      expect(connectionOf(url).password).toBe(password);
    }
  });

  it('hands the decoded password to the pg client itself', () => {
    const password = randomBytes(4).toString('hex') + URL_UNSAFE;
    const client = new pg.Client({ connectionString: databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: password }) });
    expect(client.password).toBe(password);
    expect(client.host).toBe('klipgard-db');
    expect(client.database).toBe('klipgard');
  });

  it('leaves a URL-safe password exactly as it was', (ctx) => {
    story(ctx, 'Hasło złożone z bezpiecznych znaków (np. z `openssl rand -hex 32`) daje dokładnie ten sam adres co dotąd — działające instalacje niczego nie zauważą.');
    const password = randomBytes(32).toString('hex');
    expect(databaseUrlFromEnv({ DATABASE_URL: 'db.internal:6432/app', POSTGRES_USER: 'app_user', POSTGRES_PASSWORD: password }))
      .toBe(`postgresql://app_user:${password}@db.internal:6432/app`);
    // The URL's unreserved punctuation must pass through untouched too.
    const unreserved = randomBytes(4).toString('hex') + URL_UNRESERVED;
    expect(databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: unreserved }))
      .toBe(`postgresql://klipgard:${unreserved}@klipgard-db:5432/klipgard`);
  });

  it('uses a full DATABASE_URL as is', () => {
    const full = 'postgresql://u:already%2Fencoded@h:5432/d';
    expect(databaseUrlFromEnv({ DATABASE_URL: full, POSTGRES_PASSWORD: 'ignored' })).toBe(full);
    expect(databaseUrlFromEnv({ DATABASE_URL: 'postgres://u:p@h/d' })).toBe('postgres://u:p@h/d');
  });

  it('falls back to the development defaults', () => {
    expect(databaseUrlFromEnv({})).toBe('postgresql://klipgard:devpassword@klipgard-db:5432/klipgard');
  });
});

describe('cleanFrameEnabledFromEnv', () => {
  it('is on unless explicitly turned off', (ctx) => {
    story(ctx, 'Strumień `?fmt=clean` jest domyślnie włączony — instalacja, która nie ustawi zmiennej, dostaje to samo co klienci natywni oczekują; wyłącza go wyłącznie dosłowne "false".');
    expect(cleanFrameEnabledFromEnv({})).toBe(true);
    expect(cleanFrameEnabledFromEnv({ KLIPGARD_CLEAN_FRAME_ENABLED: 'true' })).toBe(true);
    expect(cleanFrameEnabledFromEnv({ KLIPGARD_CLEAN_FRAME_ENABLED: '' })).toBe(true);
    expect(cleanFrameEnabledFromEnv({ KLIPGARD_CLEAN_FRAME_ENABLED: 'false' })).toBe(false);
  });
});

describe('internalApiKeyFromEnv', () => {
  const key = randomBytes(32).toString('hex');
  const noFile = (): string => { throw new Error('the file must not be read'); };

  it('uses the variable when it is set, without reading the file', () => {
    expect(internalApiKeyFromEnv({ KLIPGARD_INTERNAL_API_KEY: key, KLIPGARD_INTERNAL_API_KEY_FILE: '/certs/k' }, noFile)).toBe(key);
  });

  it('reads the generated key file when the variable is empty', (ctx) => {
    story(ctx, 'Instalacja self-hosted generuje klucz wewnętrzny sama (init-certs) i każda usługa czyta go z pliku — użytkownik nie musi go wpisywać do .env.');
    const read = (path: string) => { expect(path).toBe('/certs/internal-api-key'); return `${key}\n`; };
    expect(internalApiKeyFromEnv({ KLIPGARD_INTERNAL_API_KEY: '', KLIPGARD_INTERNAL_API_KEY_FILE: '/certs/internal-api-key' }, read)).toBe(key);
  });

  it('is empty with neither, so /internal refuses every caller', () => {
    expect(internalApiKeyFromEnv({}, noFile)).toBe('');
  });
});

describe('appEnvironmentFromEnv [ENV-001]', () => {
  it('uses APP_ENVIRONMENT when it names a known environment', (ctx) => {
    story(ctx, 'Operator ustawia środowisko serwera (staging) jednym polem; aplikacje używają go do sprawdzenia, że łączą się z właściwym serwerem.');
    expect(appEnvironmentFromEnv({ APP_ENVIRONMENT: 'staging' })).toBe('staging');
    expect(appEnvironmentFromEnv({ APP_ENVIRONMENT: 'production', NODE_ENV: 'development' })).toBe('production');
    expect(appEnvironmentFromEnv({ APP_ENVIRONMENT: 'development', NODE_ENV: 'production' })).toBe('development');
  });

  it('defaults to production under NODE_ENV=production and to development otherwise', () => {
    expect(appEnvironmentFromEnv({ NODE_ENV: 'production' })).toBe('production');
    expect(appEnvironmentFromEnv({ NODE_ENV: 'development' })).toBe('development');
    expect(appEnvironmentFromEnv({})).toBe('development');
  });

  it('stops the start on an unknown value and names the variable', () => {
    expect(() => appEnvironmentFromEnv({ APP_ENVIRONMENT: 'banana' })).toThrow(/APP_ENVIRONMENT/);
    expect(() => appEnvironmentFromEnv({ APP_ENVIRONMENT: 'Staging' })).toThrow(/APP_ENVIRONMENT/);
  });

  it('treats an empty value as unset', () => {
    expect(appEnvironmentFromEnv({ APP_ENVIRONMENT: '', NODE_ENV: 'production' })).toBe('production');
  });
});
