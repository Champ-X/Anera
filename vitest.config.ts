import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist-server/**', 'dist-client/**'],
    // The suite intentionally exercises real subprocess trees, loopback
    // servers, Chromium, large workspace scans, and sub-150ms lifecycle
    // accounting. Running those files concurrently makes the gate measure
    // cross-file host contention instead of the behavior under test.
    fileParallelism: false,
  },
})
