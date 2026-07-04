import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveError } from '../src/lib/errors.js';
import { unpackDocsArchive } from '../src/lib/unpack.js';

/**
 * ARC-T2 · lib/unpack.ts error branches. `os.tmpdir()` is redirected to a
 * per-test scratch dir so the "extraction temp dir is removed on failure"
 * guarantee can be asserted exactly (no other test writes there).
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

/** Directories left behind by unpackDocsArchive (must be none after a failure). */
async function leftoverUnpackDirs(): Promise<string[]> {
  const entries = await fs.readdir(scratchHolder.dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('po-ai-import-'))
    .map((e) => e.name);
}

describe('ARC-T2 · unpackDocsArchive (lib/unpack.ts)', () => {
  beforeEach(async () => {
    scratchHolder.dir = '';
    const os = await vi.importActual<typeof import('node:os')>('node:os');
    scratchHolder.dir = path.join(os.tmpdir(), `po-unpack-test-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(scratchHolder.dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(scratchHolder.dir, { recursive: true, force: true });
  });

  it('unpacks a zip, keeps only doc files (sorted) and skips directory entries', async () => {
    const zip = new AdmZip();
    zip.addFile('sub/', Buffer.alloc(0)); // explicit directory entry → skipped
    zip.addFile('b.txt', Buffer.from('b', 'utf8'));
    zip.addFile('sub/a.md', Buffer.from('a', 'utf8'));
    zip.addFile('c.markdown', Buffer.from('c', 'utf8'));
    zip.addFile('image.png', Buffer.from([1, 2, 3]));
    const file = path.join(scratchHolder.dir, 'docs.zip');
    await fs.writeFile(file, zip.toBuffer());

    const result = await unpackDocsArchive(file);
    expect(result.unsafeEntries).toBe(0);
    expect(result.files).toEqual(
      ['b.txt', 'c.markdown', path.join('sub', 'a.md')].sort((a, b) => a.localeCompare(b)),
    );
    await expect(fs.readFile(path.join(result.dir, 'sub', 'a.md'), 'utf8')).resolves.toBe('a');
    await fs.rm(result.dir, { recursive: true, force: true });
  });

  it('walks nested zip directories and returns sorted relative paths (T13)', async () => {
    const file = await writeZip({
      'docs/api/auth.md': '# Аутентификация',
      'docs/nfr/perf.md': '# Производительность',
      'readme.md': '# Обзор',
      'docs/img/logo.png': Buffer.from([1, 2, 3]), // non-doc file in a subdirectory
    });

    const result = await unpackDocsArchive(file);
    expect(result.unsafeEntries).toBe(0);
    expect(result.files).toEqual([
      path.join('docs', 'api', 'auth.md'),
      path.join('docs', 'nfr', 'perf.md'),
      'readme.md',
    ]);
    await expect(
      fs.readFile(path.join(result.dir, 'docs', 'api', 'auth.md'), 'utf8'),
    ).resolves.toBe('# Аутентификация');
    await fs.rm(result.dir, { recursive: true, force: true });
  });

  it('walks nested tar.gz directories and returns sorted relative paths (T13)', async () => {
    const src = path.join(scratchHolder.dir, 'src-nested');
    await fs.mkdir(path.join(src, 'docs', 'api'), { recursive: true });
    await fs.mkdir(path.join(src, 'docs', 'nfr'), { recursive: true });
    await fs.mkdir(path.join(src, 'docs', 'img'), { recursive: true });
    await fs.writeFile(path.join(src, 'docs', 'api', 'auth.md'), '# Аутентификация', 'utf8');
    await fs.writeFile(path.join(src, 'docs', 'nfr', 'perf.md'), '# Производительность', 'utf8');
    await fs.writeFile(path.join(src, 'readme.md'), '# Обзор', 'utf8');
    await fs.writeFile(path.join(src, 'docs', 'img', 'logo.png'), Buffer.from([1, 2, 3]));
    const file = path.join(scratchHolder.dir, 'nested.tar.gz');
    await tar.create({ gzip: true, cwd: src, file }, ['.']);

    const result = await unpackDocsArchive(file);
    expect(result.files).toEqual([
      path.join('docs', 'api', 'auth.md'),
      path.join('docs', 'nfr', 'perf.md'),
      'readme.md',
    ]);
    await fs.rm(result.dir, { recursive: true, force: true });
  });

  it('unpacks a tar.gz archive equally', async () => {
    const src = path.join(scratchHolder.dir, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'doc.md'), 'Текст.', 'utf8');
    const file = path.join(scratchHolder.dir, 'docs.tar.gz');
    await tar.create({ gzip: true, cwd: src, file }, ['.']);

    const result = await unpackDocsArchive(file);
    expect(result.files).toEqual(['doc.md']);
    await fs.rm(result.dir, { recursive: true, force: true });
  });

  it('throws ArchiveError and removes the temp dir when doc-file count exceeds the limit', async () => {
    const file = await writeZip({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    await expect(unpackDocsArchive(file, 2)).rejects.toThrow(ArchiveError);
    await expect(unpackDocsArchive(file, 2)).rejects.toThrow(
      /too many documentation files \(limit 2\)/,
    );
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('throws ArchiveError on a corrupt tar.gz (gzip magic + garbage) and cleans up', async () => {
    const file = path.join(scratchHolder.dir, 'corrupt.tar.gz');
    await fs.writeFile(file, Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(64)]));
    await expect(unpackDocsArchive(file)).rejects.toThrow(/Corrupt tar\.gz archive/);
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('throws ArchiveError on a corrupt zip ("PK" magic + garbage) and cleans up', async () => {
    const file = path.join(scratchHolder.dir, 'corrupt.zip');
    await fs.writeFile(file, Buffer.concat([Buffer.from('PK'), randomBytes(64)]));
    await expect(unpackDocsArchive(file)).rejects.toThrow(/Corrupt zip archive/);
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('rejects an unsupported format before creating any temp dir', async () => {
    const file = path.join(scratchHolder.dir, 'plain.bin');
    await fs.writeFile(file, 'not an archive at all');
    await expect(unpackDocsArchive(file)).rejects.toThrow(/Unsupported archive format/);
    expect(await leftoverUnpackDirs()).toEqual([]);
  });

  it('counts zip-slip entries as unsafe, never writing them (NFR-5)', async () => {
    // adm-zip sanitizes `../` in addFile(), so patch an equal-length name in the
    // raw bytes (same trick as ai-import-routes zip-slip test).
    const hex = randomBytes(4).toString('hex');
    const evil = `po-ev-${hex}.md`; // 16 chars
    const placeholder = `AA/po-ev-${hex}.md`; // same length as ../<evil>
    const zip = new AdmZip();
    zip.addFile('good.md', Buffer.from('ok', 'utf8'));
    zip.addFile(placeholder, Buffer.from('evil', 'utf8'));
    const raw = zip.toBuffer();
    const from = Buffer.from(placeholder);
    const to = Buffer.from(`../${evil}`);
    for (let idx = raw.indexOf(from); idx !== -1; idx = raw.indexOf(from)) to.copy(raw, idx);
    const file = path.join(scratchHolder.dir, 'slip.zip');
    await fs.writeFile(file, raw);

    const result = await unpackDocsArchive(file);
    expect(result.unsafeEntries).toBe(1);
    expect(result.files).toEqual(['good.md']);
    // The escaped path was never written next to the extraction dir.
    await expect(fs.access(path.join(scratchHolder.dir, evil))).rejects.toThrow();
    await fs.rm(result.dir, { recursive: true, force: true });
  });
});
