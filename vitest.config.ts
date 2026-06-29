import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.test.ts'],
      // CI gate: the domain core (validations, links, serialization) must stay
      // well covered. Current actuals are ~98% lines / ~94% branches.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
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
