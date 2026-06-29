import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RequirementInput } from '../src/services/RequirementService.js';

/** Create an isolated temp Projects root for a test. */
export async function makeTmpRoot(): Promise<string> {
  const dir = path.join(os.tmpdir(), `po-test-${randomBytes(8).toString('hex')}`, 'Projects');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a temp root (and its parent wrapper). */
export async function cleanup(projectsRoot: string): Promise<void> {
  await fs.rm(path.dirname(projectsRoot), { recursive: true, force: true });
}

/** A fixed clock so created/updated timestamps are deterministic in assertions. */
export const fixedNow = (): string => '2026-06-29T10:00:00.000Z';

/** Build a valid implemented FUNCTION requirement input. */
export function reqInput(overrides: Partial<RequirementInput> = {}): RequirementInput {
  return {
    type: 'FUNCTION',
    name: 'Some Requirement',
    criticality: 'MEDIUM',
    implemented: true,
    ...overrides,
  };
}
