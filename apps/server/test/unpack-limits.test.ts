import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveError } from '../src/lib/errors.js';
import { unpackDocsArchive } from '../src/lib/unpack.js';

/**
 * ARCH-5 · decompression-bomb guard for lib/unpack.ts. `os.tmpdir()` is
 * redirected to a per-test scratch dir so the "extraction temp dir is removed
 * on failure" guarantee can be asserted exactly (no other test writes there).
 */
const scratchHolder: { dir: string } = { dir: '' };

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  const tmpdir = (): string => scratchHolder.dir || os.tmpdir();
  return { ...os, tmpdir, default: { ...os, tmpdir } };
});

/** Write a zip archive (name → content) into the scratch dir. */
async function writeZip(files: Record<string, string | Buffer>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  const file = path.join(scratchHolder.dir, `in-${randomBytes(6).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

/** Write a tar.gz archive (name → content) into the scratch dir. */
async function writeTarGz(files: Record<string, string>): Promise<string> {
  const src = path.join(scratchHolder.dir, `src-${randomBytes(6).toString('hex')}`);
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(src, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }
  const file = path.join(scratchHolder.dir, `in-${randomBytes(6).toString('hex')}.tgz`);
  await tar.c({ gzip: true, file, cwd: src }, ['.']);
  return file;
}

/** Directories left behind by unpackDocsArchive (must be none after a failure). */
async function leftoverUnpackDirs(): Promise<string[]> {
  const entries = await fs.readdir(scratchHolder.dir);
  return entries.filter((e) => e.startsWith('po-ai-import-'));
}

describe('ARCH-5 unpackDocsArchive decompression-bomb guard', () => {
  beforeEach(async () => {
    scratchHolder.dir = '';
    const os = await vi.importActual<typeof import('node:os')>('node:os');
    scratchHolder.dir = path.join(os.tmpdir(), `po-unpack-lim-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(scratchHolder.dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(scratchHolder.dir, { recursive: true, force: true });
  });

  it('rejects a zip whose cumulative uncompressed size exceeds the limit; tmp cleaned', async () => {
    const file = await writeZip({ 'docs/big.md': 'x'.repeat(8192) });
    await expect(unpackDocsArchive(file, 500, { maxTotalBytes: 1024 })).rejects.toBeInstanceOf(
      ArchiveError,
    );
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('rejects a zip with too many entries; tmp cleaned', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`docs/f${i}.md`] = 'ok';
    const file = await writeZip(files);
    await expect(unpackDocsArchive(file, 500, { maxEntries: 5 })).rejects.toBeInstanceOf(
      ArchiveError,
    );
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('rejects a tar.gz whose cumulative uncompressed size exceeds the limit; tmp cleaned', async () => {
    const file = await writeTarGz({ 'docs/big.md': 'y'.repeat(8192) });
    await expect(unpackDocsArchive(file, 500, { maxTotalBytes: 1024 })).rejects.toBeInstanceOf(
      ArchiveError,
    );
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('rejects a tar.gz with too many entries; tmp cleaned', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`docs/f${i}.md`] = 'ok';
    const file = await writeTarGz(files);
    await expect(unpackDocsArchive(file, 500, { maxEntries: 5 })).rejects.toBeInstanceOf(
      ArchiveError,
    );
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('unpacks a well-formed archive within the default limits', async () => {
    const file = await writeZip({ 'docs/ok.md': '# hello', 'docs/note.txt': 'note' });
    const result = await unpackDocsArchive(file);
    expect(result.files).toEqual(['docs/note.txt', 'docs/ok.md']);
    await fs.rm(result.dir, { recursive: true, force: true });
  });
});
