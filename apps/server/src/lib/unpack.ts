import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { AI_IMPORT_MAX_DOC_FILES } from '@po/core';
import { ensureDir } from './ensureDir.js';
import { resolveSafe } from './pathSafe.js';
import { ArchiveError } from './errors.js';

/** Documentation file extensions the AI import analyzes (spec §2.1). */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/** Result of unpacking a documentation archive into a temp directory. */
export interface UnpackedDocs {
  /** Temp directory holding the extracted entries. Caller removes it. */
  dir: string;
  /** Relative paths of the documentation files, sorted alphabetically. */
  files: string[];
  /** Entries skipped because they resolved outside the temp dir (zip-slip). */
  unsafeEntries: number;
}

/** Detect the archive format from the leading magic bytes (as ArchiveRepo). */
async function detectFormat(file: string): Promise<'zip' | 'targz'> {
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

/** True when the relative path has a documentation extension. */
function isDocFile(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return (DOC_EXTENSIONS as readonly string[]).includes(ext);
}

/** Recursively collect files under `dir`, returning paths relative to it. */
async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs));
    }
  }
  return out;
}

/**
 * Unpack a documentation archive (zip / tar.gz) into a fresh directory under
 * `os.tmpdir()` and list its documentation files (`.md`/`.markdown`/`.txt`).
 *
 * Security (NFR-5): every entry path is resolved with {@link resolveSafe}
 * against the temp dir; entries that would escape it (zip-slip, `../`) are
 * skipped and counted, never written. Throws {@link ArchiveError} on an
 * unsupported/corrupt archive or when the doc-file limit is exceeded.
 * The caller is responsible for removing `dir` when done.
 */
export async function unpackDocsArchive(
  archivePath: string,
  maxDocFiles: number = AI_IMPORT_MAX_DOC_FILES,
): Promise<UnpackedDocs> {
  const format = await detectFormat(archivePath);
  const dir = path.join(os.tmpdir(), `po-ai-import-${randomBytes(8).toString('hex')}`);
  await ensureDir(dir);

  let unsafeEntries = 0;
  try {
    if (format === 'zip') {
      let zip: AdmZip;
      try {
        zip = new AdmZip(archivePath);
      } catch (err) {
        throw new ArchiveError(`Corrupt zip archive: ${(err as Error).message}`);
      }
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        let target: string;
        try {
          target = resolveSafe(dir, entry.entryName); // rejects traversal
        } catch {
          unsafeEntries += 1;
          continue;
        }
        await ensureDir(path.dirname(target));
        await fs.writeFile(target, entry.getData());
      }
    } else {
      try {
        await tar.x({
          file: archivePath,
          cwd: dir,
          filter: (p: string): boolean => {
            try {
              resolveSafe(dir, p); // rejects traversal inside the archive
              return true;
            } catch {
              unsafeEntries += 1;
              return false;
            }
          },
        });
      } catch (err) {
        throw new ArchiveError(`Corrupt tar.gz archive: ${(err as Error).message}`);
      }
    }

    const files = (await walk(dir, dir)).filter(isDocFile).sort((a, b) => a.localeCompare(b));
    if (files.length > maxDocFiles) {
      throw new ArchiveError(`Archive has too many documentation files (limit ${maxDocFiles}).`);
    }
    return { dir, files, unsafeEntries };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
