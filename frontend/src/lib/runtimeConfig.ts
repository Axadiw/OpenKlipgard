// Run-time configuration of the web app (spec/staging.md ENV-004).
//
// One image serves production and staging, so the keys that differ per
// environment (analytics id, Sentry DSN, Google/Apple client ids, Turnstile site
// key) are not baked into the bundle. The web host writes them to
// /runtime-config.js from the pod's environment (deploy/frontend-runtime/);
// index.html loads that file before the bundle. A missing value is an empty
// string, and every feature that needs one stays off.
//
// `vite dev` and tests have no such file, so each value falls back to the
// matching VITE_* variable.

export interface RuntimeConfig {
  gaId: string;
  sentryDsn: string;
  googleClientId: string;
  appleClientId: string;
  turnstileSiteKey: string;
  /** Deployment name, e.g. `production` or `staging`; labels Sentry events. */
  environment: string;
}

declare global {
  interface Window {
    __KLIPGARD_RUNTIME__?: Partial<RuntimeConfig>;
  }
}

function pick(runtime: string | undefined, fallback: unknown): string {
  if (runtime) return runtime;
  return typeof fallback === 'string' ? fallback : '';
}

export function getRuntimeConfig(): RuntimeConfig {
  const r = (typeof window !== 'undefined' ? window.__KLIPGARD_RUNTIME__ : undefined) ?? {};
  const env = import.meta.env;
  return {
    gaId: pick(r.gaId, env.VITE_GA_ID),
    sentryDsn: pick(r.sentryDsn, env.VITE_SENTRY_DSN),
    googleClientId: pick(r.googleClientId, env.VITE_GOOGLE_CLIENT_ID),
    appleClientId: pick(r.appleClientId, env.VITE_APPLE_CLIENT_ID),
    turnstileSiteKey: pick(r.turnstileSiteKey, env.VITE_TURNSTILE_SITE_KEY),
    environment: pick(r.environment, undefined) || 'production',
  };
}
