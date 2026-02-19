import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/auth/**/*.test.ts'],
    globals: false,
    testTimeout: 10000,
  },
});
