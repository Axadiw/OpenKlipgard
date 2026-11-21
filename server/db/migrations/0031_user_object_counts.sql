-- The object count that the storage reconciler saw for each account on its
-- last run (DATA-154), against the per-account ceiling of DATA-153. The admin
-- usage view reads it so an operator sees an account near the ceiling before
-- its listing goes partial. Additive only.
CREATE TABLE IF NOT EXISTS "user_object_counts" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "object_count" integer NOT NULL,
  "ceiling" integer NOT NULL,
  "partial" text,
  "counted_at" timestamp with time zone DEFAULT now() NOT NULL
);
