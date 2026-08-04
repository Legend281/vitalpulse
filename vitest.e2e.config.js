import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e-kyc-flow.test.js'],
    hookTimeout: 30000,
    testTimeout: 45000,
  },
});
