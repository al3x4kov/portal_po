import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/core/src/**/*.ts', 'apps/server/src/**/*.ts', 'apps/mcp/src/**/*.ts'],
      // Exclude barrels, tests, process entrypoints (bootstrap, not unit-testable),
      // and type-only files (no executable lines).
      exclude: ['**/index.ts', '**/*.test.ts', '**/main.ts', 'apps/server/src/routes/deps.ts'],
      // CI gate with per-area floors. The domain core (validations, links,
      // serialization) stays strict; server + MCP wrappers have their own floors
      // set below current actuals (core ~98/94, server ~90+, mcp ~99) with headroom
      // so ordinary changes don't trip the gate but regressions do.
      thresholds: {
        'packages/core/src/**': { lines: 90, statements: 90, functions: 90, branches: 90 },
        'apps/server/src/**': { lines: 80, statements: 80, functions: 80, branches: 70 },
        'apps/mcp/src/**': { lines: 90, statements: 90, functions: 85, branches: 88 },
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'packages/**/*.{test,spec}.ts',
            'apps/server/**/*.{test,spec}.ts',
            'apps/mcp/**/*.{test,spec}.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
          environment: 'node',
        },
      },
      './apps/web/vitest.config.ts',
    ],
  },
});
