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

/**
 * Remove a temp root (and its parent wrapper). Retries a couple of times:
 * todo_20 job checkpoints are written asynchronously (fire-and-forget queue),
 * so a write can land while the recursive rm walks the tree (ENOTEMPTY race).
 */
export async function cleanup(projectsRoot: string): Promise<void> {
  const target = path.dirname(projectsRoot);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'ENOTEMPTY' || code === 'EBUSY')) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw err;
    }
  }
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
