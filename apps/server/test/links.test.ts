import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CycleError,
  MultipleParentError,
  SelfLinkError,
  TypeMismatchError,
  type Requirement,
} from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { ConflictError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('T-404 LinkService', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let reqs: RequirementService;
  let links: LinkService;
  let a: Requirement;
  let b: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    a = await reqs.create(reqInput({ name: 'A' }));
    b = await reqs.create(reqInput({ name: 'B' }));
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const load = async (id: string): Promise<Requirement> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.id === id)!;
  };

  it('writes a reciprocal pair into both files (FR-8.3)', async () => {
    await links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id });
    expect((await load(a.id)).links).toContainEqual({ type: 'PARENT_OF', targetId: b.id });
    expect((await load(b.id)).links).toContainEqual({ type: 'CHILD_OF', targetId: a.id });
  });

  it('removing a link clears both sides', async () => {
    await links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id });
    await links.remove({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id });
    expect((await load(a.id)).links).toEqual([]);
    expect((await load(b.id)).links).toEqual([]);
  });

  it('rejects self-link (422)', async () => {
    await expect(
      links.create({ sourceId: a.id, type: 'RELATES_TO', targetId: a.id }),
    ).rejects.toBeInstanceOf(SelfLinkError);
  });

  it('rejects a hierarchical link across types (422)', async () => {
    const nfr = await reqs.create(reqInput({ name: 'N', type: 'NFR' }));
    await expect(
      links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: nfr.id }),
    ).rejects.toBeInstanceOf(TypeMismatchError);
  });

  it('rejects a second parent (409)', async () => {
    const c = await reqs.create(reqInput({ name: 'C' }));
    await links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id }); // b CHILD_OF a
    await expect(
      links.create({ sourceId: c.id, type: 'PARENT_OF', targetId: b.id }),
    ).rejects.toBeInstanceOf(MultipleParentError);
  });

  it('rejects a cycle (409)', async () => {
    await links.create({ sourceId: a.id, type: 'PARENT_OF', targetId: b.id });
    await expect(
      links.create({ sourceId: b.id, type: 'PARENT_OF', targetId: a.id }),
    ).rejects.toBeInstanceOf(CycleError);
  });

  it('rejects a duplicate link (409)', async () => {
    await links.create({ sourceId: a.id, type: 'RELATES_TO', targetId: b.id });
    await expect(
      links.create({ sourceId: a.id, type: 'RELATES_TO', targetId: b.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('cascade delete removes back-references in other files (FR-9.2)', async () => {
    await links.create({ sourceId: a.id, type: 'RELATES_TO', targetId: b.id });
    await reqs.delete(b.id);
    const remaining = await load(a.id);
    expect(remaining.links).toEqual([]);
  });
});
