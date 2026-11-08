import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The bundle smoke test builds first; give the suite room on a busy machine.
    testTimeout: 20_000,
  },
});
