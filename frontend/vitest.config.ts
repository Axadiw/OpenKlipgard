import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    // 5 s is the vitest default. On the shared CI runners these jsdom-style
    // suites run next to eight other jobs, and the heaviest renders
    // (TimelineView) took 5.4-5.6 s in the first CI run of the flaky-test
    // work: "Test timed out in 5000ms" with nothing wrong in the test. A test
    // that passes returns at once; only a hung one waits the full budget.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 20_000 : 10_000,
    setupFiles: ['src/test-setup.ts'],
    // Same JSON reporter as the server — reused from ../server/testing/. The
    // STORY_REPORT_OUTPUT env var (set in package.json `test` script) steers
    // the output to the repo-root test-results/vitest-frontend.json.
    reporters: process.env.CI
      ? ['default']
      : ['default', '../server/testing/json-story-reporter.ts'],
  },
});
