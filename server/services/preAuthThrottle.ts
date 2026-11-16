// server/services/preAuthThrottle.ts
//
// A per-address budget for the guesses that cost a bcrypt but touch no account:
// a camera login for a username that does not exist. Such a guess can never
// succeed and advances no per-account counter, so without a budget one address
// could burn the API's CPU with it indefinitely. In-memory and per pod (with
// several pods the effective budget is a multiple of this one), bounded in
// size; a restart forgets it, which only gives an address a fresh budget.

const WINDOW_MS = 15 * 60 * 1000;
/** Unknown-username attempts one address may spend per window before it is refused outright. */
const UNKNOWN_USER_BUDGET = 50;
const MAX_ENTRIES = 50_000;

const seen = new Map<string, { count: number; windowStart: number }>();

function current(ip: string, now: number): { count: number; windowStart: number } | undefined {
  const e = seen.get(ip);
  if (!e) return undefined;
  if (now - e.windowStart >= WINDOW_MS) {
    seen.delete(ip);
    return undefined;
  }
  return e;
}

/** Has this address used up its budget of unknown-username attempts? */
export function preAuthBlocked(ip: string | null): boolean {
  if (!ip) return false;
  const e = current(ip, Date.now());
  return !!e && e.count >= UNKNOWN_USER_BUDGET;
}

/** Spend one attempt of the address's budget. */
export function recordUnknownUserFailure(ip: string | null): void {
  if (!ip) return;
  const now = Date.now();
  const e = current(ip, now);
  if (e) {
    e.count += 1;
    return;
  }
  // Map iterates in insertion order: the first key is the oldest window.
  if (seen.size >= MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.set(ip, { count: 1, windowStart: now });
}

export function __resetForTest(): void {
  seen.clear();
}
