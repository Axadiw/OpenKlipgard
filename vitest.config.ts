import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    globals: true,
    // Loads .env so DB-touching tests can auto-discover the local docker
    // postgres (DATABASE_URL is derived from POSTGRES_* vars in .env). CI
    // sets DATABASE_URL directly, which this setup respects without
    // overwriting.
    setupFiles: ['./server/testing/load-env-for-tests.ts'],
    // Migrates one template database per run; DB test files copy it through
    // createScratchDb (server/testing/scratch-db.ts) instead of each
    // replaying every migration in beforeAll.
    globalSetup: ['./server/testing/db-template.global-setup.ts'],
    // Hook timeout bumped from the 10s default to 60s. The migration suites
    // (db.migrate*, db.schema-roundtrip) still replay every migration into a
    // scratch schema in beforeAll — drizzle's baseline SQL with a schema
    // rewrite per statement, 3-10s on CI's Postgres 14 (sub-second locally on
    // 16) — and 10s leaves no headroom when several files start at once.
    hookTimeout: 60_000,
    // 5 s is the vitest default; on a CI runner shared with seven other jobs a
    // plain route test (events.security 'S3 stream errors AFTER headers') took
    // 5.0-6.7 s in two jobs of the same run and passed on every local repeat.
    // A passing test returns at once; the budget only bounds a hung one.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    // Dual reporter: default console output PLUS a custom JSON dump with
    // per-test story annotations (see server/testing/json-story-reporter.ts).
    // The JSON output path is controlled by STORY_REPORT_OUTPUT — set it in
    // the npm script so it lands at repo-root test-results/.
    reporters: process.env.CI
      ? ['default']
      : ['default', './server/testing/json-story-reporter.ts'],
  },
});
