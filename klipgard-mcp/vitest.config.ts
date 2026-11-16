import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    // Same reasoning as the root config: 5 s is too tight on a shared CI runner.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    pool: 'forks',
    // Load .env so DB-touching tests auto-discover the local postgres (mirrors
    // the root vitest.config.ts setup for server/**/*.test.ts tests).
    setupFiles: [new URL('../server/testing/load-env-for-tests.ts', import.meta.url).pathname],
    // The public origin the OAuth issuer, resource and discovery URLs derive
    // from (config.ts). Pinned so the tests read the same everywhere instead of
    // depending on the code's default or the developer's environment.
    env: { PUBLIC_MCP_URL: 'https://klipgard.example' },
  },
});
