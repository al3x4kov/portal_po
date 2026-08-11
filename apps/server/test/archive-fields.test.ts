import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportOptionalField } from '@po/core';
import { createProjectService } from '../src/factory.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';
import type { ArchiveFormat, ExportResult } from '../src/repositories/ArchiveRepo.js';

/** Тело архива буфером: побайтовый экспорт tar.gz отдаёт поток, а не Buffer. */
async function bodyToBuffer(result: ExportResult): Promise<Buffer> {
  if (Buffer.isBuffer(result.body)) return result.body;
  const chunks: Buffer[] = [];
  for await (const chunk of result.body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Поток можно вычитать один раз — заменяем тело буфером для повторного чтения. */
async function materialize(result: ExportResult): Promise<ExportResult> {
  return { ...result, body: await bodyToBuffer(result) };
}

/** Read every `.md`/manifest entry of an archive into a rel-path → content map. */
async function readArchive(result: ExportResult): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const body = await bodyToBuffer(result);
  if (result.filename.endsWith('.zip')) {
    const zip = new AdmZip(body);
    for (const e of zip.getEntries()) {
      if (!e.isDirectory) map.set(e.entryName.replace(/\\/g, '/'), e.getData().toString('utf8'));
    }
    return map;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'po-untar-'));
  const file = path.join(dir, `a-${randomBytes(4).toString('hex')}.tar.gz`);
  await fs.writeFile(file, body);
  await tar.x({ file, cwd: dir });
  const walk = async (d: string, base: string): Promise<void> => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      if (ent.name.endsWith('.tar.gz')) continue;
      const abs = path.join(d, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(abs, rel);
      else map.set(rel, await fs.readFile(abs, 'utf8'));
    }
  };
  await walk(dir, '');
  await fs.rm(dir, { recursive: true, force: true });
  return map;
}

/** Persist an archive to disk so it can be re-imported. */
async function bodyToFile(result: ExportResult, dir: string): Promise<string> {
  const ext = result.filename.endsWith('.zip') ? 'zip' : 'tar.gz';
  const file = path.join(dir, `out-${randomBytes(4).toString('hex')}.${ext}`);
  await fs.writeFile(file, await bodyToBuffer(result));
  return file;
}

describe('T-202 filtered archives (reserialization by field mask)', () => {
  let root: string;
  let svc: ReturnType<typeof createProjectService>;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    svc = createProjectService({ projectsRoot: root, now: fixedNow });
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-arch-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  /** Seed "Source" with a rich parent (source/description/info) + linked child. */
  async function seedSource(): Promise<{ parentSlug: string; childSlug: string }> {
    await svc.create('Source');
    const repo = new FsRequirementRepo(root, 'Source');
    const reqs = new RequirementService(repo, fixedNow);
    const links = new LinkService(repo, fixedNow);
    const parent = await reqs.create(
      reqInput({
        name: 'Parent',
        source: 'АС21',
        description: 'Parent body text.',
        infoItems: [{ type: 'Регламент', value: 'РД-42' }],
      }),
    );
    const child = await reqs.create(reqInput({ name: 'Child' }));
    await links.create({ sourceSlug: parent.slug, type: 'PARENT_OF', targetSlug: child.slug });
    return { parentSlug: parent.slug, childSlug: child.slug };
  }

  const parentMd = (files: Map<string, string>, slug: string): string => {
    const key = [...files.keys()].find((k) => k.endsWith(`functions/${slug}.md`));
    expect(key, `parent md for ${slug}`).toBeTruthy();
    return files.get(key!)!;
  };

  for (const format of ['zip', 'targz'] as ArchiveFormat[]) {
    it(`${format}: mask [links] keeps only the Links section among optionals`, async () => {
      const { parentSlug } = await seedSource();
      const result = await svc.export('Source', format, ['links']);
      const files = await readArchive(result);
      const md = parentMd(files, parentSlug);
      expect(md).toContain('#### Links');
      expect(md).toContain('- createdAt:');
      expect(md).toContain('- updatedAt:');
      expect(md).not.toContain('- source:');
      expect(md).not.toContain('Parent body text.');
      expect(md).not.toContain('#### Info');
      // Manifest is preserved so the archive re-imports.
      expect([...files.keys()].some((k) => k.endsWith('openspec/project.md'))).toBe(true);
    });

    it(`${format}: empty mask keeps only mandatory sections and re-imports cleanly`, async () => {
      const { parentSlug } = await seedSource();
      const result = await svc.export('Source', format, []);
      const files = await readArchive(result);
      const md = parentMd(files, parentSlug);
      expect(md).toContain('### Requirement: Parent');
      expect(md).toContain('- criticality:');
      expect(md).toContain('- createdAt:');
      expect(md).not.toContain('- source:');
      expect(md).not.toContain('#### Links');
      expect(md).not.toContain('#### Info');

      // Filtered archive must still be a valid, importable project.
      const file = await bodyToFile(result, scratch);
      const imported = await svc.import(file, `Copy-empty-${format}`);
      const repo = new FsRequirementRepo(root, imported.id);
      const { requirements, broken } = await repo.loadAll();
      expect(broken).toEqual([]);
      expect(requirements.map((r) => r.name).sort()).toEqual(['Child', 'Parent']);
      expect(requirements.every((r) => r.links.length === 0)).toBe(true);
    });

    it(`${format}: полная маска = побайтовая копия, импорт со связями`, async () => {
      const { parentSlug, childSlug } = await seedSource();
      const all: ExportOptionalField[] = ['source', 'description', 'info', 'links'];
      const result = await materialize(await svc.export('Source', format, all));
      const files = await readArchive(result);
      const md = parentMd(files, parentSlug);
      expect(md).toContain('- source: АС21');
      expect(md).toContain('Parent body text.');
      expect(md).toContain('#### Info');
      expect(md).toContain('#### Links');

      const file = await bodyToFile(result, scratch);
      const imported = await svc.import(file, `Copy-full-${format}`);
      const { requirements } = await new FsRequirementRepo(root, imported.id).loadAll();
      const parent = requirements.find((r) => r.name === 'Parent')!;
      expect(parent.links).toContainEqual({ type: 'PARENT_OF', targetSlug: childSlug });
    });

    it(`${format}: exportSelected with a subset drops links to excluded slugs`, async () => {
      const { parentSlug } = await seedSource();
      // Export only the parent → its PARENT_OF link to the excluded child must be dropped.
      const result = await svc.exportSelected('Source', [parentSlug], format, ['links']);
      const files = await readArchive(result);
      const md = parentMd(files, parentSlug);
      expect(md).not.toContain('#### Links');

      const file = await bodyToFile(result, scratch);
      const imported = await svc.import(file, `Copy-selected-${format}`);
      const { requirements, broken } = await new FsRequirementRepo(root, imported.id).loadAll();
      expect(broken).toEqual([]);
      expect(requirements.map((r) => r.name)).toEqual(['Parent']);
    });
  }
});
