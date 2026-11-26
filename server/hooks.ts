// server/hooks.ts
//
// Edition hooks: the points where the shared core hands a side effect to the
// edition instead of doing it itself. Klipgard Cloud installs implementations
// (e.g. transactional email); the self-hosted edition installs none, and the
// core treats a missing hook as "nothing to do".
//
// Installed once per process — `createApp()` does it for the API, and every
// worker/cron entrypoint does it explicitly — so core services can stay free
// of any edition import.

export interface StorageWarningInput {
  userId: number;
  email: string;
  /** When the edition last warned this user (from `users.storage_warn_email_sent_at`), or null. */
  lastWarnedAt: Date | null;
  diskUsageBytes: number;
  diskLimitBytes: number;
  percent: number;
}

/** What a sign-in policy may look at. */
export interface SignInSubject {
  emailVerified?: boolean;
  isAdmin?: boolean;
}

/** An answer that replaces the tokens a sign-in would otherwise issue. */
export interface SignInRefusal {
  status: number;
  body: { error: string; code: string };
}

export interface EditionHooks {
  /**
   * Usage crossed the 90 % storage-warning threshold and no auto-delete is
   * configured. Returns true when a warning was actually delivered (the hook
   * owns its own cooldown). Absent ⇒ no warning channel in this edition.
   */
  storageWarning?: (input: StorageWarningInput) => Promise<boolean>;
  /**
   * Extra rule every way of getting a session applies once the credentials
   * were proven (password, passkey, backup code, provider sign-in, token
   * refresh, TV pairing). Returns the refusal to send, or null to go on.
   * Absent ⇒ no extra rule (the account's credentials are enough).
   */
  signInRefusal?: (user: SignInSubject) => SignInRefusal | null;
  /**
   * A passkey challenge for one account, handed out only after its password
   * was proven (the 400 `passkeyRequired` answer of POST /auth/login): the
   * caller already holds the password, so naming the account's credentials
   * tells them nothing new. Null/absent ⇒ the 400 carries no challenge.
   */
  passkeyChallenge?: (userId: number) => Promise<{ sessionId: string; options: unknown } | null>;
  /**
   * The account's operator suspended it, so its recordings may be needed by
   * the authorities (API-CORE-050): automatic deletion never runs for it. The
   * edition decides what "suspended" means. Absent ⇒ nothing suspends an
   * account in this edition, and only a lock pauses automatic deletion.
   */
  accountSuspended?: (userId: number) => Promise<boolean>;
}

let installed: EditionHooks = {};

export function installEditionHooks(hooks: EditionHooks | undefined): void {
  installed = hooks ?? {};
}

export function editionHooks(): EditionHooks {
  return installed;
}

/** The installed edition's sign-in rule for `user`; null ⇒ the sign-in may go on. */
export function signInRefusal(user: SignInSubject): SignInRefusal | null {
  return installed.signInRefusal?.(user) ?? null;
}
