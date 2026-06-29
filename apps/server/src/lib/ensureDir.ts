import { promises as fs } from 'node:fs';

/** Create a directory (and any missing parents); a no-op when it already exists. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
