import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each file boots an in-process Postgres (PGlite), which is slower than a plain unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
