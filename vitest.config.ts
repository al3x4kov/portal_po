import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
  },
});
