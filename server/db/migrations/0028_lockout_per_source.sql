-- Failed-login lockouts keyed on (account, source address).
-- login_failures counts failures per account, channel and source address, so
-- a lockout earned from one address no longer blocks the account's owner at
-- another; last_success_at marks an address the account has signed in from,
-- which the account-wide backstop lockout spares.
-- user_bans.scope says what a lockout row is keyed on ('account',
-- 'account_ip' or 'ip'); NULL (rows from before) is read from source_ip.
-- Additive only.
CREATE TABLE IF NOT EXISTS "login_failures" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "source_ip" inet NOT NULL,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "lockout_count" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "login_failures_user_id_channel_source_ip_pk" PRIMARY KEY("user_id","channel","source_ip")
);
--> statement-breakpoint
ALTER TABLE "user_bans" ADD COLUMN IF NOT EXISTS "scope" text;
