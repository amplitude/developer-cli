import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    maxWorkers: 8,
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
