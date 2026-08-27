import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        name: 'functions',
        environment: 'node',
        include: ['functions/src/**/*.test.ts'],
      },
      {
        name: 'frontend',
        environment: 'jsdom',
        include: ['vitalpulse_app/src/**/*.test.js'],
      },
    ],
  },
});
