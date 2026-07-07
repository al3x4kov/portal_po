import { promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { AI_IMPORT_MAX_DOC_FILES } from '@po/core';
import { ensureDir } from './ensureDir.js';
import { resolveSafe } from './pathSafe.js';
import { ArchiveError } from './errors.js';
import { detectArchiveFormat } from './archiveFormat.js';
import { type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from './limits.js';

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
  /** Number of file (non-directory) entries found in the archive. */
  totalEntries: number;
  /** Extension → count over extracted files (lowercased; '' = no extension; macOS junk excluded). */
  extensionCounts: Record<string, number>;
}

/**
 * Normalize an archive entry name to a relative POSIX-style path: backslashes
 * become '/', a Windows drive prefix ('C:'), leading '/' and leading './'
 * segments are stripped. `..` segments are intentionally KEPT so that
 * {@link resolveSafe} still rejects traversal — zip-slip defense is unchanged.
 * Real-world Finder/Windows archives carry absolute or backslash entry names;
 * without normalization every entry would be silently dropped as "unsafe".
 */
export function normalizeEntryName(entryName: string): string {
  let name = entryName.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  for (;;) {
    const stripped = name.replace(/^\/+/, '').replace(/^(\.\/)+/, '');
    if (stripped === name) return name;
    name = stripped;
  }
}

/** macOS Finder metadata: the `__MACOSX/` payload and AppleDouble `._*` files. */
function isMacJunk(rel: string): boolean {
  const parts = rel.split(path.sep);
  return parts.includes('__MACOSX') || (parts[parts.length - 1] ?? '').startsWith('._');
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
 *
 * Decompression-bomb guard (ARCH-5): the cumulative *uncompressed* size and
 * total entry count are accounted INCREMENTALLY as the archive is walked and,
 * for zip, BEFORE each entry is written — so a small compressed archive can
 * never expand into gigabytes on disk before a limit trips. Bounds come from
 * {@link DEFAULT_ARCHIVE_LIMITS} (see lib/limits.ts, the single source).
 */
export async function unpackDocsArchive(
  archivePath: string,
  maxDocFiles: number = AI_IMPORT_MAX_DOC_FILES,
  limits: Partial<ArchiveLimits> = {},
): Promise<UnpackedDocs> {
  const { maxEntries, maxTotalBytes } = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  const format = await detectArchiveFormat(archivePath);
  const dir = path.join(os.tmpdir(), `po-ai-import-${randomBytes(8).toString('hex')}`);
  await ensureDir(dir);

  let unsafeEntries = 0;
  let totalEntries = 0;
  // Cumulative bomb-guard counters shared across the whole archive.
  let accountedEntries = 0;
  let accountedBytes = 0;
  const account = (bytes: number): void => {
    accountedEntries += 1;
    accountedBytes += bytes;
    if (accountedEntries > maxEntries) {
      throw new ArchiveError(`Archive has too many entries (limit ${maxEntries}).`);
    }
    if (accountedBytes > maxTotalBytes) {
      throw new ArchiveError(
        `Archive exceeds the uncompressed size limit (${maxTotalBytes} bytes).`,
      );
    }
  };
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
        const name = normalizeEntryName(entry.entryName);
        if (name === '' || name.endsWith('/')) continue; // directory-like entry
        totalEntries += 1;
        account(entry.header.size); // uncompressed size, checked before writing
        let target: string;
        try {
          target = resolveSafe(dir, name); // rejects traversal ('..')
        } catch {
          unsafeEntries += 1;
          continue;
        }
        await ensureDir(path.dirname(target));
        await fs.writeFile(target, entry.getData());
      }
    } else {
      // node-tar surfaces a throw from `filter` as an *uncaught* stream error,
      // so we capture the first bomb-guard violation, skip the offending entry,
      // and re-throw once extraction settles — nothing oversized is written.
      let violation: Error | null = null;
      try {
        await tar.x({
          file: archivePath,
          cwd: dir,
          filter: (p: string, entry: tar.ReadEntry | Stats): boolean => {
            if (violation) return false;
            const isFile = 'type' in entry ? entry.type === 'File' : entry.isFile();
            if (isFile) totalEntries += 1;
            const name = normalizeEntryName(p);
            if (name === '') {
              if (isFile) unsafeEntries += 1;
              return false;
            }
            try {
              // Check the normalized name: tar itself strips absolute prefixes
              // on extraction; '..' traversal is still rejected here.
              resolveSafe(dir, name);
            } catch {
              if (isFile) unsafeEntries += 1;
              return false;
            }
            if (isFile) {
              try {
                account(entry.size); // rejects bomb (entries / uncompressed size)
              } catch (err) {
                violation = err as Error;
                return false;
              }
            }
            return true;
          },
        });
      } catch (err) {
        if (err instanceof ArchiveError) throw err;
        throw new ArchiveError(`Corrupt tar.gz archive: ${(err as Error).message}`);
      }
      if (violation) throw violation;
      // tar cannot rename entries during extraction: on POSIX an entry named
      // 'docs\sub\index.md' lands as ONE literal file — move it into place.
      for (const rel of await walk(dir, dir)) {
        if (!rel.includes('\\')) continue;
        const name = normalizeEntryName(rel.split(path.sep).join('/'));
        const from = path.join(dir, rel);
        let target: string;
        try {
          if (name === '') throw new Error('empty entry name');
          target = resolveSafe(dir, name);
        } catch {
          unsafeEntries += 1;
          await fs.rm(from, { force: true });
          continue;
        }
        if (target === from) continue;
        await ensureDir(path.dirname(target));
        await fs.rename(from, target);
      }
    }

    const extracted = (await walk(dir, dir)).filter((rel) => !isMacJunk(rel));
    const extensionCounts: Record<string, number> = {};
    for (const rel of extracted) {
      const ext = path.extname(rel).toLowerCase();
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    }
    const files = extracted.filter(isDocFile).sort((a, b) => a.localeCompare(b));
    if (files.length > maxDocFiles) {
      throw new ArchiveError(`Archive has too many documentation files (limit ${maxDocFiles}).`);
    }
    return { dir, files, unsafeEntries, totalEntries, extensionCounts };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
