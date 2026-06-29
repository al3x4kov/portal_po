import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/**/*.{test,spec}.ts', 'apps/server/**/*.{test,spec}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
          environment: 'node',
        },
      },
      './apps/web/vitest.config.ts',
    ],
  },
});
