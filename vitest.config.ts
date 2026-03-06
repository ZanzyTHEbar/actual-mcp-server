import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/auth/**/*.test.ts',
      'tests/logger/**/*.test.ts',
    ],
    globals: false,
    testTimeout: 30000,
  },
});
