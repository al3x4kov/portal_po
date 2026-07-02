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
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('T-805 LinkService (slug-based)', () => {
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

  const load = async (slug: string): Promise<Requirement> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.slug === slug)!;
  };

  it('writes a reciprocal pair into both files (FR-8.3)', async () => {
    await links.create({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: b.slug });
    expect((await load(a.slug)).links).toContainEqual({ type: 'PARENT_OF', targetSlug: b.slug });
    expect((await load(b.slug)).links).toContainEqual({ type: 'CHILD_OF', targetSlug: a.slug });
  });

  it('removing a link clears both sides', async () => {
    await links.create({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: b.slug });
    await links.remove({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: b.slug });
    expect((await load(a.slug)).links).toEqual([]);
    expect((await load(b.slug)).links).toEqual([]);
  });

  it('rejects self-link (422)', async () => {
    await expect(
      links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: a.slug }),
    ).rejects.toBeInstanceOf(SelfLinkError);
  });

  it('rejects a hierarchical link across types (422)', async () => {
    const nfr = await reqs.create(reqInput({ name: 'N', type: 'NFR' }));
    await expect(
      links.create({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: nfr.slug }),
    ).rejects.toBeInstanceOf(TypeMismatchError);
  });

  it('rejects a second parent (409)', async () => {
    const c = await reqs.create(reqInput({ name: 'C' }));
    await links.create({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: b.slug });
    await expect(
      links.create({ sourceSlug: c.slug, type: 'PARENT_OF', targetSlug: b.slug }),
    ).rejects.toBeInstanceOf(MultipleParentError);
  });

  it('rejects a cycle (409)', async () => {
    await links.create({ sourceSlug: a.slug, type: 'PARENT_OF', targetSlug: b.slug });
    await expect(
      links.create({ sourceSlug: b.slug, type: 'PARENT_OF', targetSlug: a.slug }),
    ).rejects.toBeInstanceOf(CycleError);
  });

  it('rejects a duplicate link (409)', async () => {
    await links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: b.slug });
    await expect(
      links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: b.slug }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('S16 rejects a link to a nonexistent target (no dangling references, 404)', async () => {
    await expect(
      links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: 'ghost' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The source file must be untouched — a rejected link leaves no partial edge.
    expect((await load(a.slug)).links).toEqual([]);
  });

  it('cascade delete removes back-references in other files (FR-9.2)', async () => {
    await links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: b.slug });
    await reqs.delete(b.slug);
    const remaining = await load(a.slug);
    expect(remaining.links).toEqual([]);
  });
});
