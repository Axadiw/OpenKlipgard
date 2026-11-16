-- Reuse detection for refresh tokens (API-CORE-063): the position of the
-- session's current refresh token. Additive; every existing session starts at 0,
-- which is also the position a token issued before this column carries.
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "refresh_seq" integer DEFAULT 0 NOT NULL;
