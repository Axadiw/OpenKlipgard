-- Push devices bound to the sign-in they were registered under.
-- push_devices gains session_id (the user_sessions id) and token_generation
-- (the account's generation at registration). Fan-out skips a row whose
-- session was revoked or whose generation is no longer the account's, so a
-- signed-out or lost device stops receiving recording pushes.
--
-- Rows that exist now are backfilled with their owner's CURRENT generation, so
-- they keep working today and are cut off by the next sign-out everywhere /
-- password change / ban. session_id stays NULL for them (no session binding)
-- until the app re-registers, which it does on every launch.
--
-- Additive; safe for old pods during the rollout. An old pod inserts rows with
-- both columns NULL, which the fan-out treats as unbound (still delivered).
-- An old pod re-pointing an existing token keeps the previous binding, so at
-- worst that device is filtered until its next launch registers it again.
ALTER TABLE "push_devices" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN IF NOT EXISTS "token_generation" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_devices_session" ON "push_devices" USING btree ("session_id");--> statement-breakpoint
UPDATE "push_devices" pd SET "token_generation" = u."token_generation"
  FROM "users" u WHERE pd."user_id" = u."id" AND pd."token_generation" IS NULL;
