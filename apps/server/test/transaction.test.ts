import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Requirement } from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

/**
 * Repo that fails the Nth low-level write after being armed — mirrors the
 * fault-injection pattern of atomicWrite.test.ts, but at the batch boundary so
 * we can prove multi-file operations are all-or-nothing (ARCH-1 / BE-7).
 */
class FaultyRepo extends FsRequirementRepo {
  private calls = 0;
  private failOnCall = Number.POSITIVE_INFINITY;

  /** Arm the repo to throw on the `nth` subsequent write (1-based). */
  arm(nth: number): void {
    this.calls = 0;
    this.failOnCall = nth;
  }

  protected override async persistFile(absPath: string, data: string): Promise<void> {
    this.calls += 1;
    if (this.calls === this.failOnCall) {
      throw new Error('injected write failure');
    }
    await super.persistFile(absPath, data);
  }
}

describe('ARCH-1/BE-7 transactional multi-file writes', () => {
  let root: string;
  let repo: FaultyRepo;
  let reqs: RequirementService;
  let links: LinkService;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FaultyRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const load = async (slug: string): Promise<Requirement | undefined> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.slug === slug);
  };

  it('a failure on the second link write leaves NO one-sided link', async () => {
    const a = await reqs.create(reqInput({ name: 'A' }));
    const b = await reqs.create(reqInput({ name: 'B' }));

    repo.arm(2); // source write (1) ok, target write (2) fails
    await expect(
      links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: b.slug }),
    ).rejects.toThrow(/injected write failure/);

    // Neither side may carry the link: the batch rolled the source back.
    expect((await load(a.slug))!.links).toEqual([]);
    expect((await load(b.slug))!.links).toEqual([]);
    const { broken } = await repo.loadAll();
    expect(broken).toEqual([]);
  });

  it('a failure mid-cascade leaves NO dangling targetSlug (all-or-nothing)', async () => {
    const x = await reqs.create(reqInput({ name: 'X' }));
    const a = await reqs.create(reqInput({ name: 'A' }));
    const b = await reqs.create(reqInput({ name: 'B' }));
    // A and B both reference X, so deleting X must rewrite both.
    await links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: x.slug });
    await links.create({ sourceSlug: b.slug, type: 'RELATES_TO', targetSlug: x.slug });

    repo.arm(2); // first neighbour rewrite ok, second fails → rollback everything
    await expect(reqs.delete(x.slug)).rejects.toThrow(/injected write failure/);

    // X survives and both neighbours still point at it — no dangling reference.
    const xr = await load(x.slug);
    expect(xr).toBeDefined();
    expect((await load(a.slug))!.links).toContainEqual({ type: 'RELATES_TO', targetSlug: x.slug });
    expect((await load(b.slug))!.links).toContainEqual({ type: 'RELATES_TO', targetSlug: x.slug });
    const { broken } = await repo.loadAll();
    expect(broken).toEqual([]);
    // No stray temp files leaked into the functions folder.
    const dir = path.join(root, 'P', 'openspec', 'specs', 'functions');
    expect((await fs.readdir(dir)).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });
});
