/**
 * task22 — import of zip/tar.gz whose content sits under a root wrapper
 * directory (the standard result of zipping a folder: Finder, GitHub
 * releases, Gitea downloads). The importer must descend through a single
 * wrapper subdirectory (ignoring `__MACOSX` / dot-entries) up to a bounded
 * depth until it finds `openspec/`, for both zip and tar.gz.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectService } from '../src/factory.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { ArchiveError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import type { ArchiveFormat } from '../src/repositories/ArchiveRepo.js';

const VALID_REQ = [
  '### Requirement: Alpha',
  '- criticality: MEDIUM',
  '- implemented: true',
  '- createdAt: 2026-01-01T00:00:00Z',
  '- updatedAt: 2026-01-01T00:00:00Z',
  '',
].join('\n');

describe('task22 archive import with root wrapper directory', () => {
  let root: string;
  let svc: ReturnType<typeof createProjectService>;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    svc = createProjectService({ projectsRoot: root, now: fixedNow });
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-wrap-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  /** Build an archive of the given format from a rel-path → content map. */
  async function buildArchive(
    format: ArchiveFormat,
    files: Record<string, string>,
  ): Promise<string> {
    const suffix = randomBytes(4).toString('hex');
    if (format === 'zip') {
      const zip = new AdmZip();
      for (const [rel, content] of Object.entries(files)) {
        zip.addFile(rel, Buffer.from(content, 'utf8'));
      }
      const file = path.join(scratch, `arch-${suffix}.zip`);
      await fs.writeFile(file, zip.toBuffer());
      return file;
    }
    const srcDir = await fs.mkdtemp(path.join(scratch, 'src-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(srcDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
    const file = path.join(scratch, `arch-${suffix}.tar.gz`);
    await tar.create({ gzip: true, cwd: srcDir, file }, ['.']);
    return file;
  }

  /** Import must succeed and yield the seeded requirement under the given name. */
  async function expectImportOk(file: string, name: string): Promise<void> {
    const imported = await svc.import(file, name);
    expect(imported.id).toBe(name);
    const repo = new FsRequirementRepo(root, imported.id);
    const { requirements, broken } = await repo.loadAll();
    expect(broken).toEqual([]);
    expect(requirements.map((r) => r.slug)).toEqual(['a']);
    expect(requirements[0]!.name).toBe('Alpha');
  }

  for (const format of ['zip', 'targz'] as ArchiveFormat[]) {
    it(`imports ${format} with a single wrapper directory (wrapper/openspec/...)`, async () => {
      const file = await buildArchive(format, {
        'Gitea 1.19.0/openspec/specs/functions/a.md': VALID_REQ,
      });
      await expectImportOk(file, `Wrapped ${format}`);
    });

    it(`still imports ${format} with openspec/ at the archive root (no regression)`, async () => {
      const file = await buildArchive(format, {
        'openspec/specs/functions/a.md': VALID_REQ,
      });
      await expectImportOk(file, `Rooted ${format}`);
    });

    it(`imports ${format} with a double wrapper (a/b/openspec/...)`, async () => {
      const file = await buildArchive(format, {
        'a/b/openspec/specs/functions/a.md': VALID_REQ,
      });
      await expectImportOk(file, `Double ${format}`);
    });

    it(`imports ${format} ignoring __MACOSX and dot-entries next to the wrapper`, async () => {
      const file = await buildArchive(format, {
        'wrapper/openspec/specs/functions/a.md': VALID_REQ,
        '__MACOSX/wrapper/._a.md': 'resource fork junk',
        '.DS_Store': 'finder junk',
      });
      await expectImportOk(file, `Macos ${format}`);
    });

    it(`rejects ${format} without openspec/ with a message describing the expected structure`, async () => {
      const file = await buildArchive(format, {
        'docs/readme.md': 'no openspec here',
      });
      const err = await svc.import(file, `NoSpec ${format}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArchiveError);
      const message = (err as ArchiveError).message;
      expect(message).toMatch(/openspec\//);
      expect(message).toMatch(/specs\//);
      expect(message).toMatch(/project\.md/);
      // Atomicity: target dir never created, temp swept.
      await expect(fs.stat(path.join(root, `NoSpec ${format}`))).rejects.toBeTruthy();
      const leftovers = await fs.readdir(path.join(root, '.import-tmp')).catch(() => []);
      expect(leftovers).toEqual([]);
    });

    it(`rejects ${format} whose wrapper nesting exceeds the depth limit`, async () => {
      const file = await buildArchive(format, {
        'a/b/c/d/openspec/specs/functions/a.md': VALID_REQ,
      });
      const err = await svc.import(file, `TooDeep ${format}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArchiveError);
      await expect(fs.stat(path.join(root, `TooDeep ${format}`))).rejects.toBeTruthy();
    });
  }

  it('does not descend when there are two sibling non-service directories', async () => {
    // Ambiguous root: two real candidate dirs, neither is openspec → clear error.
    const file = await buildArchive('zip', {
      'one/openspec/specs/functions/a.md': VALID_REQ,
      'two/junk.md': 'x',
    });
    const err = await svc.import(file, 'Ambiguous').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'Ambiguous'))).rejects.toBeTruthy();
  });
});
