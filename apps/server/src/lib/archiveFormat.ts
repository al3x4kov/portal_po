import { promises as fs } from 'node:fs';
import { ArchiveError } from './errors.js';

/** The two archive container formats the app reads/writes (FR-3 / FR-10). */
export type ArchiveFormat = 'zip' | 'targz';

/**
 * Detect the archive container format from the leading magic bytes — the single
 * source of truth shared by {@link ArchiveRepo} (full-project archives) and
 * `lib/unpack.ts` (AI-import doc archives) so the two detectors can never drift
 * (BE-5). Throws {@link ArchiveError} on an unsupported/corrupt header.
 */
export async function detectArchiveFormat(file: string): Promise<ArchiveFormat> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // "PK"
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'targz'; // gzip
    throw new ArchiveError('Unsupported archive format (expected .zip or .tar.gz).');
  } finally {
    await fh.close();
  }
}
