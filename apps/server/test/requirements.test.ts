import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HasChildrenError, UniquenessError, ValidationError } from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('T-401/T-402/T-405 requirements repo + service', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let service: RequirementService;
  let reqDir: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    service = new RequirementService(repo, fixedNow);
    reqDir = path.join(root, 'P', 'requirements');
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('creates a requirement at requirements/<id>.md with timestamps (T-401/T-402)', async () => {
    const r = await service.create(reqInput({ name: 'Login' }));
    expect(r.createdAt).toBe(fixedNow());
    expect(r.updatedAt).toBe(fixedNow());
    expect((await fs.stat(path.join(reqDir, `${r.id}.md`))).isFile()).toBe(true);
    const { requirements } = await repo.loadAll();
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.name).toBe('Login');
  });

  it('rejects a duplicate name within the same type (409 / UniquenessError)', async () => {
    await service.create(reqInput({ name: 'Login' }));
    await expect(service.create(reqInput({ name: 'login' }))).rejects.toBeInstanceOf(
      UniquenessError,
    );
    // Same name, different type is allowed.
    await expect(service.create(reqInput({ name: 'Login', type: 'NFR' }))).resolves.toBeTruthy();
  });

  it('rejects implemented=false without quarter/year (422 / ValidationError)', async () => {
    await expect(
      service.create(reqInput({ name: 'X', implemented: false })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.create(
        reqInput({ name: 'X', implemented: false, targetQuarter: 'Q3', targetYear: 2026 }),
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects an over-long name (422)', async () => {
    await expect(service.create(reqInput({ name: 'a'.repeat(201) }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('update keeps id/type/createdAt and refreshes updatedAt', async () => {
    const r = await service.create(reqInput({ name: 'Orig' }));
    const updated = await service.update(r.id, {
      name: 'Renamed',
      criticality: 'HIGH',
      implemented: true,
    });
    expect(updated.id).toBe(r.id);
    expect(updated.type).toBe('FUNCTION');
    expect(updated.createdAt).toBe(r.createdAt);
    expect(updated.name).toBe('Renamed');
  });

  it('update of a missing requirement is a 404', async () => {
    await expect(
      service.update('NOPE', { name: 'x', criticality: 'LOW', implemented: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('check-name reflects availability with type + self-exclusion (FR-6.6)', async () => {
    const r = await service.create(reqInput({ name: 'Taken' }));
    expect(await service.checkName('FUNCTION', 'Taken')).toBe(false);
    expect(await service.checkName('FUNCTION', 'Free')).toBe(true);
    expect(await service.checkName('NFR', 'Taken')).toBe(true);
    // Renaming to its own current name is allowed when own id is excluded.
    expect(await service.checkName('FUNCTION', 'Taken', r.id)).toBe(true);
  });

  it('flags a broken .md file without crashing the load (§2.5)', async () => {
    await service.create(reqInput({ name: 'Good' }));
    await fs.writeFile(path.join(reqDir, 'broken.md'), '---\nnot: valid\n---\nbody');
    const { requirements, broken } = await repo.loadAll();
    expect(requirements).toHaveLength(1);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.file).toBe('broken.md');
  });

  it('deletes a leaf requirement and removes its file (FR-9.2)', async () => {
    const r = await service.create(reqInput({ name: 'Leaf' }));
    await service.delete(r.id);
    await expect(fs.stat(path.join(reqDir, `${r.id}.md`))).rejects.toBeTruthy();
  });

  it('blocks deletion of a node that still has children (FR-9.3)', async () => {
    const parent = await service.create(reqInput({ name: 'Parent' }));
    const child = await service.create(reqInput({ name: 'Child' }));
    // Make child a CHILD_OF parent by writing the link directly.
    const { requirements } = await repo.loadAll();
    const c = requirements.find((x) => x.id === child.id)!;
    c.links.push({ type: 'CHILD_OF', targetId: parent.id });
    await repo.write(c);
    await expect(service.delete(parent.id)).rejects.toBeInstanceOf(HasChildrenError);
  });
});
