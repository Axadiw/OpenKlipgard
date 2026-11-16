import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { story } from './testing/story.js';

// Root vitest run: cwd is the repo root.
const SCRIPT = join(process.cwd(), 'deploy', 'frontend-runtime', '40-klipgard-runtime.sh');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'klipgard-runtime-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(env: Record<string, string>) {
  const r = spawnSync('sh', [SCRIPT], { env: { PATH: process.env.PATH ?? '', KLIPGARD_RUNTIME_DIR: dir, ...env }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return {
    js: readFileSync(join(dir, 'runtime-config.js'), 'utf8'),
    headers: readFileSync(join(dir, 'headers.conf'), 'utf8'),
    locations: readFileSync(join(dir, 'locations.conf'), 'utf8'),
  };
}

/** Evaluates the generated file the way a browser would and returns window.__KLIPGARD_RUNTIME__. */
function evaluate(js: string): Record<string, string> {
  const win: Record<string, unknown> = {};
  new Function('window', js)(win);
  return win.__KLIPGARD_RUNTIME__ as Record<string, string>;
}

describe('40-klipgard-runtime.sh [ENV-003][ENV-004]', () => {
  it('round-trips hostile values without letting them break out of the script', (ctx) => {
    story(ctx, 'Wartość klucza z cudzysłowem, </script>, znakiem nowej linii czy U+2028 nie może wstrzyknąć kodu na stronę — plik runtime-config.js zawsze jest poprawnym JS i oddaje dokładnie to, co było w ConfigMapie.');
    const nasty = 'a"b</script><img src=x onerror=alert(1)>\n\\ óą \'x\' &amp;';
    const { js } = run({ FRONTEND_GA_ID: nasty, FRONTEND_SENTRY_DSN: 'https://k@s.example/1' });
    expect(js).not.toContain('</script>');
    expect(js).not.toContain('onerror');
    const cfg = evaluate(js);
    expect(cfg.gaId).toBe(nasty);
    expect(cfg.sentryDsn).toBe('https://k@s.example/1');
  });

  it('writes valid JS with empty strings when nothing is set', () => {
    const { js } = run({});
    expect(evaluate(js)).toEqual({
      gaId: '', sentryDsn: '', googleClientId: '', appleClientId: '', turnstileSiteKey: '', environment: 'production',
    });
  });

  it('maps all six variables and reports the environment', () => {
    const { js } = run({
      FRONTEND_GA_ID: 'ga-1', FRONTEND_SENTRY_DSN: 'd', FRONTEND_GOOGLE_CLIENT_ID: 'g',
      FRONTEND_APPLE_CLIENT_ID: 'a', FRONTEND_TURNSTILE_SITE_KEY: 't', APP_ENVIRONMENT: 'staging',
    });
    expect(evaluate(js)).toEqual({
      gaId: 'ga-1', sentryDsn: 'd', googleClientId: 'g', appleClientId: 'a', turnstileSiteKey: 't', environment: 'staging',
    });
  });

  it('adds noindex headers and a disallow-all robots.txt only in staging', () => {
    const staging = run({ APP_ENVIRONMENT: 'staging' });
    expect(staging.headers).toContain('add_header X-Robots-Tag "noindex, nofollow" always;');
    expect(staging.locations).toContain('location = /robots.txt');
    expect(staging.locations).toContain('User-agent: *\\nDisallow: /');
    const prod = run({ APP_ENVIRONMENT: 'production' });
    expect(prod.headers.trim()).toBe('');
    expect(prod.locations.trim()).toBe('');
    const unset = run({});
    expect(unset.headers.trim()).toBe('');
  });

  it('treats an unknown environment as production for headers (never noindex by accident)', () => {
    expect(run({ APP_ENVIRONMENT: 'Staging ' }).headers.trim()).toBe('');
  });
});
