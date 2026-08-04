import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['firestore.rules.test.js', 'concurrency.rules.test.js', 'storage.rules.test.js'],
    hookTimeout: 30000,
    testTimeout: 15000,
  },
});
