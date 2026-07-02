import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest } from '@po/core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FsProjectRepo, MANIFEST_PATH } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('ARCH-2/SA-8/QA-3 cross-process serialization (ADR-003)', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let reqs: RequirementService;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('N concurrent creates that collapse to the same slug all persist with unique slugs', async () => {
    // Distinct names (each passes the name-uniqueness rule) that all slugify to
    // "same-name" — this is exactly the read-modify-write race the lock guards:
    // without serialization every call reads the same empty set and writes the
    // same file, silently clobbering the others.
    const names = [
      'Same Name',
      'Same Name.',
      'Same Name!',
      'Same Name?',
      'Same Name,',
      'Same Name;',
      'Same Name:',
      'Same Name*',
    ];
    const N = names.length;
    const created = await Promise.all(names.map((name) => reqs.create(reqInput({ name }))));

    // Every create returned a distinct slug (…-2/-3/…), none dropped.
    const returned = created.map((r) => r.slug);
    expect(new Set(returned).size).toBe(N);

    const { requirements, broken } = await repo.loadAll();
    expect(broken).toEqual([]); // no clobbered / half-written files
    expect(requirements).toHaveLength(N);
    const slugs = requirements.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(N); // no duplicate slug on disk
    expect(slugs).toContain('same-name');
    expect(slugs).toContain('same-name-2');

    // Manifest stays parseable/valid.
    const raw = await fs.readFile(path.join(root, 'P', MANIFEST_PATH), 'utf8');
    expect(parseManifest(raw).name).toBe('P');
  });

  it('concurrent updates to one requirement stay consistent (no corruption)', async () => {
    const r = await reqs.create(reqInput({ name: 'Target' }));
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        reqs.update(r.slug, reqInput({ name: 'Target', criticality: i % 2 ? 'HIGH' : 'LOW' })),
      ),
    );
    const { requirements, broken } = await repo.loadAll();
    expect(broken).toEqual([]);
    const only = requirements.filter((x) => x.slug === r.slug);
    expect(only).toHaveLength(1);
    expect(['HIGH', 'LOW']).toContain(only[0]!.criticality);
  });
});
