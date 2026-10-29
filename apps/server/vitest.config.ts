import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The live provider test only runs via `npm run test:integration` with NTL_INTEGRATION=1.
    exclude: process.env.NTL_INTEGRATION === '1' ? [] : ['test/integration/**'],
    testTimeout: 15000,
  },
});
