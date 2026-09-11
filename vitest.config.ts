import { defineConfig } from 'vitest/config'
import { BROWSER_TESTS, INTEGRATION_TESTS, TEST_INCLUDE } from './src/eval/test-tiers.js'

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist-server/**', 'dist-client/**'],
    // The suite intentionally exercises real subprocess trees, loopback
    // servers, Chromium, large workspace scans, and sub-150ms lifecycle
    // accounting. Running those files concurrently makes the gate measure
    // cross-file host contention instead of the behavior under test.
    fileParallelism: false,
    // A test command cannot inherit billable credentials from the developer's
    // .env. Real-provider acceptance lives outside Vitest, behind its budget.
    setupFiles: ['src/eval/offline-test-setup.ts'],
    projects: [
      { extends: true, test: { name: 'module', include: TEST_INCLUDE,
        exclude: [...INTEGRATION_TESTS, ...BROWSER_TESTS] } },
      { extends: true, test: { name: 'integration', include: INTEGRATION_TESTS,
        exclude: BROWSER_TESTS } },
      { extends: true, test: { name: 'browser', include: BROWSER_TESTS } },
    ],
  },
})
