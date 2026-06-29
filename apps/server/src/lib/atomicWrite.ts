import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ensureDir } from './ensureDir.js';

/**
 * Atomically write `data` to `filePath` (NFR-4): the bytes land in a sibling
 * temp file that is fsync'd and then `rename`d over the destination. A failure
 * never leaves a partially written destination — on error the temp file is
 * removed and any pre-existing destination is untouched.
 */
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}-${path.basename(filePath)}`);

  try {
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
