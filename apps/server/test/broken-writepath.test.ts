import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('ARCH-3 broken files are honoured in the write-path', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let reqs: RequirementService;
  let links: LinkService;
  let functionsDir: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    functionsDir = path.join(root, 'P', 'openspec', 'specs', 'functions');
    await fs.mkdir(functionsDir, { recursive: true });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('create with a slug matching a broken file gets a suffix (no overwrite)', async () => {
    const brokenPath = path.join(functionsDir, 'some-requirement.md');
    const garbage = 'this file has no requirement header';
    await fs.writeFile(brokenPath, garbage);

    const created = await reqs.create(reqInput({ name: 'Some Requirement' }));

    // Deduped away from the broken file's slug…
    expect(created.slug).toBe('some-requirement-2');
    // …and the broken file is left byte-for-byte untouched.
    expect(await fs.readFile(brokenPath, 'utf8')).toBe(garbage);
  });

  it('checkName reports the deduped slug when a broken file occupies it', async () => {
    await fs.writeFile(path.join(functionsDir, 'widget.md'), 'broken');
    const result = await reqs.checkName('FUNCTION', 'Widget');
    expect(result.slug).toBe('widget-2');
  });

  it('cascade delete is safe when a broken file references the deleted slug', async () => {
    const a = await reqs.create(reqInput({ name: 'A' }));
    const b = await reqs.create(reqInput({ name: 'B' }));
    await links.create({ sourceSlug: a.slug, type: 'RELATES_TO', targetSlug: b.slug });

    // A corrupt file that textually references b's slug but cannot be parsed.
    const brokenPath = path.join(functionsDir, 'corrupt.md');
    const brokenBody = `not valid, mentions ${b.slug} in passing`;
    await fs.writeFile(brokenPath, brokenBody);

    // Deletion succeeds and does not throw over the un-parseable neighbour.
    await expect(reqs.delete(b.slug)).resolves.toBeUndefined();

    const { requirements, broken } = await repo.loadAll();
    // Valid back-reference stripped; b gone.
    expect(requirements.find((r) => r.slug === a.slug)!.links).toEqual([]);
    expect(requirements.find((r) => r.slug === b.slug)).toBeUndefined();
    // Broken file remains present and untouched (predictable, no data loss).
    expect(broken.map((x) => x.slug)).toContain('corrupt');
    expect(await fs.readFile(brokenPath, 'utf8')).toBe(brokenBody);
  });
});
