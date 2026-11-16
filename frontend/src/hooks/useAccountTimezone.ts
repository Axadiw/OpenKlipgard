import { useState, useEffect } from 'react';
import { api } from '../api';

/**
 * The account's IANA timezone — the zone the cameras' wall clock belongs to.
 * Drives everything that has to sit on the wall-clock axis rather than on real
 * UTC: the timeline's now-line, "today", the default `?date=`.
 *
 * Web was the only client without this plumbing (`getAccountTimezone` was
 * called from the settings tab and nowhere else), which is why the green
 * now-line stood `offset` hours away from the newest clips. iOS keeps it in
 * `SettingsStore.timeZoneID`, Android in `TimelineViewModel.displayTimeZone`.
 */
export const ACCOUNT_TZ_KEY = 'klipgard.accountTimezone';

/** The device zone. Same default the mobile clients start from — for the
 *  overwhelming majority of accounts it already equals the account zone, so
 *  the pre-fetch frame is right rather than merely harmless. */
function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isResolvable(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readCache(): string | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_TZ_KEY);
    return raw && isResolvable(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Module-level so N mounted consumers share ONE request, and so a remount
// (route change back to the timeline) doesn't refetch. `inflight` is also the
// dedupe key — resolved value lands in `cached` and in localStorage.
let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

function load(): Promise<string | null> {
  if (inflight) return inflight;
  inflight = api.getAccountTimezone()
    .then(({ timezone }) => {
      if (!timezone || !isResolvable(timezone)) return null;
      cached = timezone;
      try { localStorage.setItem(ACCOUNT_TZ_KEY, timezone); } catch { /* private mode — memory cache still holds */ }
      return timezone;
    })
    .catch(() => null);   // offline / 401 mid-refresh — caller keeps the device zone
  return inflight;
}

// Mounted hooks, told about a zone that changed in this tab.
const listeners = new Set<(tz: string) => void>();

/**
 * Tell every mounted consumer that the server accepted a new account zone.
 * Without it the per-page cache above keeps the old value until a reload
 * (WEB-SET-GENERAL-026). It also replaces the in-flight result, so a view that
 * mounts afterwards does not read the zone from before the change.
 */
export function publishAccountTimezone(tz: string): void {
  if (!isResolvable(tz)) return;
  cached = tz;
  inflight = Promise.resolve(tz);
  try { localStorage.setItem(ACCOUNT_TZ_KEY, tz); } catch { /* private mode — memory cache still holds */ }
  listeners.forEach(listener => listener(tz));
}

/** Forget the account zone. Call on sign-out: the zone belongs to the account
 *  but localStorage belongs to the device, so the next user on this machine
 *  would otherwise open the timeline framed on someone else's clock. */
export function clearAccountTimezone(): void {
  cached = null;
  inflight = null;
  try { localStorage.removeItem(ACCOUNT_TZ_KEY); } catch { /* nothing to clear */ }
}

/**
 * The account timezone, seeded synchronously from the last known value so the
 * first painted frame is already correct on every mount after the first.
 * Falls back to the device zone until (and if) the account zone is known.
 */
export function useAccountTimezone(): string {
  const [tz, setTz] = useState<string>(() => cached ?? readCache() ?? deviceTimezone());

  useEffect(() => {
    let alive = true;
    load().then(resolved => { if (alive && resolved) setTz(resolved); });
    listeners.add(setTz);
    return () => { alive = false; listeners.delete(setTz); };
  }, []);

  return tz;
}
