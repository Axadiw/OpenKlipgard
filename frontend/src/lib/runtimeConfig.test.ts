import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRuntimeConfig } from './runtimeConfig';
import { story } from '../test-story';

afterEach(() => {
  delete window.__KLIPGARD_RUNTIME__;
  vi.unstubAllEnvs();
});

describe('getRuntimeConfig [ENV-004]', () => {
  it('returns the values the web host wrote into window.__KLIPGARD_RUNTIME__', (ctx) => {
    story(ctx, 'Ten sam obraz frontendu działa na produkcji i stagingu: klucze Google, Apple, GA, Sentry i Turnstile przychodzą z /runtime-config.js, nie z budowania.');
    window.__KLIPGARD_RUNTIME__ = {
      gaId: 'ga-x', sentryDsn: 'https://k@s.example/1', googleClientId: 'g', appleClientId: 'a',
      turnstileSiteKey: 't', environment: 'staging',
    };
    expect(getRuntimeConfig()).toEqual({
      gaId: 'ga-x', sentryDsn: 'https://k@s.example/1', googleClientId: 'g', appleClientId: 'a',
      turnstileSiteKey: 't', environment: 'staging',
    });
  });

  it('falls back to the VITE_* variables so `vite dev` keeps working', () => {
    vi.stubEnv('VITE_GA_ID', 'dev-id');
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'tt');
    const c = getRuntimeConfig();
    expect(c.gaId).toBe('dev-id');
    expect(c.turnstileSiteKey).toBe('tt');
  });

  it('turns every missing value into an empty string and defaults the environment to production', () => {
    vi.stubEnv('VITE_GA_ID', '');
    const c = getRuntimeConfig();
    expect(c).toEqual({
      gaId: '', sentryDsn: '', googleClientId: '', appleClientId: '', turnstileSiteKey: '', environment: 'production',
    });
  });

  it('prefers a non-empty runtime value over the VITE_* fallback and ignores an empty one', () => {
    vi.stubEnv('VITE_GA_ID', 'fallback-id');
    window.__KLIPGARD_RUNTIME__ = { gaId: '' };
    expect(getRuntimeConfig().gaId).toBe('fallback-id');
    window.__KLIPGARD_RUNTIME__ = { gaId: 'runtime-id' };
    expect(getRuntimeConfig().gaId).toBe('runtime-id');
  });
});
