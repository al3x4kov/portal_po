import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/core/src/**/*.ts',
        'apps/server/src/**/*.ts',
        'apps/mcp/src/**/*.ts',
        // QA-4 / BE-10: web is now measured and gated too.
        'apps/web/src/**/*.{ts,tsx}',
      ],
      // Exclude barrels, tests, process entrypoints (bootstrap, not unit-testable),
      // and type-only files (no executable lines).
      exclude: [
        '**/index.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/main.ts',
        'apps/server/src/routes/deps.ts',
        // Web: bootstrap entry, test helpers and type-only modules.
        'apps/web/src/main.tsx',
        'apps/web/src/test/**',
        'apps/web/src/api/types.ts',
        'apps/web/src/vite-env.d.ts',
      ],
      // CI gate with per-area floors. The domain core (validations, links,
      // serialization) stays strict; server + MCP wrappers have their own floors
      // set below current actuals (core ~98/94, server ~90+, mcp ~99) with headroom
      // so ordinary changes don't trip the gate but regressions do. Web floors sit
      // below current actuals (lines/stmts ~97.7, branches ~91.7, functions ~93) with
      // headroom so QA-3/QA-4/BE-10 catches web-coverage regressions. QA-3 raised the
      // web floors (functions 62→85, branches 78→86, lines/stmts 82→90) after adding
      // handler/store tests: the old functions floor left ~38% of web functions ungated.
      thresholds: {
        'packages/core/src/**': { lines: 90, statements: 90, functions: 90, branches: 90 },
        'apps/server/src/**': { lines: 80, statements: 80, functions: 80, branches: 70 },
        'apps/mcp/src/**': { lines: 90, statements: 90, functions: 85, branches: 88 },
        'apps/web/src/**': { lines: 90, statements: 90, functions: 85, branches: 86 },
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
