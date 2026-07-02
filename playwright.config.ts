import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

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

// Desktop viewport tall enough for the full requirement modal (with the
// conditional target-date block expanded, ~835px) to render its footer actions.
const DESKTOP = { width: 1280, height: 1024 } as const;

/**
 * QA-9 · cross-browser matrix beyond Chromium. WebKit/Firefox are only added
 * when their browser binaries are actually installed, so `npm run e2e` stays
 * green on a Chromium-only machine (run `npx playwright install webkit firefox`
 * to light them up). They run a thin `@smoke` slice, not the full suite.
 */
function browserInstalled(prefix: string): boolean {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    return existsSync(root) && readdirSync(root).some((d) => d.startsWith(prefix));
  } catch {
    return false;
  }
}

const projects: Project[] = [
  {
    name: 'chromium',
    // Full suite. Viewport override must live in the project `use` to beat the
    // device preset.
    use: { ...devices['Desktop Chrome'], viewport: DESKTOP },
  },
];

if (browserInstalled('webkit')) {
  projects.push({
    name: 'webkit-smoke',
    use: { ...devices['Desktop Safari'], viewport: DESKTOP },
    grep: /@smoke/,
  });
}
if (browserInstalled('firefox')) {
  projects.push({
    name: 'firefox-smoke',
    use: { ...devices['Desktop Firefox'], viewport: DESKTOP },
    grep: /@smoke/,
  });
}

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  // Shared filesystem state (single server + one Projects/ root) ⇒ run serially
  // for deterministic, flake-free runs. Tests stay isolated via unique names.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // QA-7: flaky budget is zero — retries must not mask non-determinism. A test
  // either passes deterministically or it is a defect to fix, not to re-run.
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects,
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
