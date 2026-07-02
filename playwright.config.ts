import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config (E7). Boots the REAL application for E2E:
 *   1. `npm run build` compiles core + server + web (apps/web/dist).
 *   2. `node apps/server/dist/main.js` serves the SPA on `/` and the API on `/api`.
 *
 * Isolation: the server runs against a fresh, throwaway PROJECTS_ROOT created
 * by global-setup.ts. Individual tests further isolate by using unique project
 * and requirement names (see e2e/tests/helpers/app.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 41730);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

// Deterministic temp Projects/ root, shared between this process, the webServer
// (via env below) and the test workers (which recompute the same default).
const PROJECTS_ROOT = process.env.E2E_PROJECTS_ROOT ?? path.join(os.tmpdir(), 'po-e2e-projects');
process.env.E2E_PROJECTS_ROOT = PROJECTS_ROOT;

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  // Shared filesystem state (single server + one Projects/ root) ⇒ run serially
  // for deterministic, flake-free runs. Tests stay isolated via unique names.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // Desktop viewport tall enough for the full requirement modal (with the
      // conditional target-date block expanded, ~835px) to render its footer
      // actions. Must live in the project `use` to override the device preset.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 1024 } },
    },
  ],
  webServer: {
    command: 'npm run build && node apps/server/dist/main.js',
    url: `${BASE_URL}/healthz`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      HOST,
      PROJECTS_ROOT,
      LOG_LEVEL: 'warn',
    },
  },
});
