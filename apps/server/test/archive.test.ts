import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../src/services/ProjectService.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { ArchiveError, ConflictError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';
import type { ArchiveFormat, ExportResult } from '../src/repositories/ArchiveRepo.js';

async function bodyToFile(result: ExportResult, dir: string): Promise<string> {
  const ext = result.filename.endsWith('.zip') ? 'zip' : 'tar.gz';
  const file = path.join(dir, `out-${randomBytes(4).toString('hex')}.${ext}`);
  if (Buffer.isBuffer(result.body)) {
    await fs.writeFile(file, result.body);
  } else {
    await pipeline(result.body as Readable, createWriteStream(file));
  }
  return file;
}

describe('T-501/T-502 import-export', () => {
  let root: string;
  let svc: ProjectService;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    svc = new ProjectService(root, fixedNow);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-arch-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  /** Build a project "Source" with two linked requirements. */
  async function seedSource(): Promise<{ ids: string[] }> {
    await svc.create('Source');
    const repo = new FsRequirementRepo(root, 'Source');
    const reqs = new RequirementService(repo, fixedNow);
    const links = new LinkService(repo, fixedNow);
    const a = await reqs.create(reqInput({ name: 'Parent' }));
    const b = await reqs.create(reqInput({ name: 'Child' }));
    await links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id });
    return { ids: [a.id, b.id].sort() };
  }

  for (const format of ['zip', 'targz'] as ArchiveFormat[]) {
    it(`round-trips export(${format}) -> import preserving requirements and links`, async () => {
      const { ids } = await seedSource();
      const exported = await svc.export('Source', format);
      const file = await bodyToFile(exported, scratch);

      const imported = await svc.import(file, `Copy ${format}`);
      const repo = new FsRequirementRepo(root, imported.id);
      const { requirements, broken } = await repo.loadAll();
      expect(broken).toEqual([]);
      expect(requirements.map((r) => r.id).sort()).toEqual(ids);
      const parent = requirements.find((r) => r.name === 'Parent')!;
      expect(parent.links).toContainEqual({ type: 'PARENT_OF', targetId: requirements.find((r) => r.name === 'Child')!.id });
    });
  }

  it('rejects importing a duplicate project name (409)', async () => {
    await seedSource();
    const exported = await svc.export('Source', 'zip');
    const file = await bodyToFile(exported, scratch);
    await svc.create('Existing');
    await expect(svc.import(file, 'Existing')).rejects.toBeInstanceOf(ConflictError);
  });

  it('rolls back a broken archive: no target dir, temp cleaned (FR-3.4)', async () => {
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify({ name: 'X', schemaVersion: 1, createdAt: 'now' })));
    zip.addFile('requirements/bad.md', Buffer.from('---\nbroken: true\n---\noops'));
    const file = path.join(scratch, 'broken.zip');
    await fs.writeFile(file, zip.toBuffer());

    await expect(svc.import(file, 'BadProject')).rejects.toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'BadProject'))).rejects.toBeTruthy();
    const tmp = path.join(root, '.import-tmp');
    const leftovers = await fs.readdir(tmp).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('rejects an archive entry that escapes via path traversal', async () => {
    const zip = new AdmZip();
    zip.addFile('../escape.md', Buffer.from('pwned'));
    const file = path.join(scratch, 'evil.zip');
    await fs.writeFile(file, zip.toBuffer());

    await expect(svc.import(file, 'Evil')).rejects.toBeTruthy();
    // Nothing escaped above the Projects root.
    await expect(fs.stat(path.join(path.dirname(root), 'escape.md'))).rejects.toBeTruthy();
  });

  it('rejects an unknown archive format', async () => {
    const file = path.join(scratch, 'plain.bin');
    await fs.writeFile(file, Buffer.from('not an archive'));
    await expect(svc.import(file, 'Plain')).rejects.toBeInstanceOf(ArchiveError);
  });
});
