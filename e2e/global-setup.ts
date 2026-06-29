import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Wipe and recreate the throwaway Projects/ root before the suite runs, so each
 * `playwright test` invocation starts from a clean, empty portal directory.
 */
export default async function globalSetup(): Promise<void> {
  const root = process.env.E2E_PROJECTS_ROOT ?? path.join(os.tmpdir(), 'po-e2e-projects');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
}
