// A local-only memory of "this e-mail last signed in here with a passkey", so
// the sign-in page can start the ceremony by itself without asking the server
// which method the account uses (the server no longer answers that). Keyed by
// a hash of the lower-cased e-mail; nothing here ever leaves the browser.
// Every access is best-effort: storage can be blocked or empty.

async function keyFor(email: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(email.trim().toLowerCase());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `klipgard.passkeyHint.${hex.slice(0, 32)}`;
  } catch {
    return null;
  }
}

export async function hasPasskeyHint(email: string): Promise<boolean> {
  try {
    const key = await keyFor(email);
    return key !== null && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export async function setPasskeyHint(email: string, on: boolean): Promise<void> {
  try {
    const key = await keyFor(email);
    if (key === null) return;
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable — the hint is only a convenience */
  }
}
