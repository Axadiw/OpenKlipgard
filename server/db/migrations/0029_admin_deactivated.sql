-- Deactivation by an administrator is a sanction, told apart from a pending
-- approval (both have active = false): only PUT /users/:id/active sets and
-- clears this marker, and no payment, invite or sync turns the account back on
-- while it is set. Additive, no backfill (earlier deactivations have no marker).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_deactivated_at" timestamp with time zone;
