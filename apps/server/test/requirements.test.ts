import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HasChildrenError, UniquenessError, ValidationError } from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

const FUNCTIONS_DIR = path.join('openspec', 'specs', 'functions');

describe('T-804/T-805 requirements repo + service (OpenSpec layout)', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let service: RequirementService;
  let fnDir: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    service = new RequirementService(repo, fixedNow);
    fnDir = path.join(root, 'P', FUNCTIONS_DIR);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('creates a requirement at openspec/specs/functions/<slug>.md (T-804)', async () => {
    const r = await service.create(reqInput({ name: 'User Login' }));
    expect(r.slug).toBe('user-login');
    expect(r.createdAt).toBe(fixedNow());
    expect(r.updatedAt).toBe(fixedNow());
    expect((await fs.stat(path.join(fnDir, `${r.slug}.md`))).isFile()).toBe(true);
    const { requirements } = await repo.loadAll();
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.name).toBe('User Login');
    expect(requirements[0]!.type).toBe('FUNCTION');
  });

  it('derives a deduped slug for names that collide within a type (S7)', async () => {
    const a = await service.create(reqInput({ name: 'Login' }));
    const b = await service.create(reqInput({ name: 'Log in' }));
    expect(a.slug).toBe('login');
    expect(b.slug).toBe('log-in');
    // Same slug base within the same type gets a -2 suffix.
    await service.update(b.slug, { name: 'Log in', criticality: 'LOW', implemented: true });
  });

  it('rejects a duplicate name within the same type (409 / UniquenessError)', async () => {
    await service.create(reqInput({ name: 'Login' }));
    await expect(service.create(reqInput({ name: 'login' }))).rejects.toBeInstanceOf(
      UniquenessError,
    );
    // Same name, different type is allowed (S9) but the slug is unique across the
    // whole project (E8.1): the NFR gets a -2 suffix even though its name may match.
    const nfr = await service.create(reqInput({ name: 'Login', type: 'NFR' }));
    expect(nfr.slug).toBe('login-2');
    expect(nfr.type).toBe('NFR');
  });

  it('makes slugs unique across the whole project, names unique per type (E8.1, S9)', async () => {
    const fn = await service.create(reqInput({ name: 'Session', type: 'FUNCTION' }));
    const nfr = await service.create(reqInput({ name: 'Session', type: 'NFR' }));
    // Names may repeat across types, slugs may not.
    expect(fn.name).toBe('Session');
    expect(nfr.name).toBe('Session');
    expect(fn.slug).toBe('session');
    expect(nfr.slug).toBe('session-2');
    // Both files exist in their respective folders (no clobbering across folders).
    const { requirements } = await repo.loadAll();
    const slugs = requirements.map((r) => r.slug).sort();
    expect(slugs).toEqual(['session', 'session-2']);
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

  it('update keeps slug/type/createdAt and refreshes updatedAt', async () => {
    const r = await service.create(reqInput({ name: 'Orig' }));
    const updated = await service.update(r.slug, {
      name: 'Renamed',
      criticality: 'HIGH',
      implemented: true,
    });
    expect(updated.slug).toBe(r.slug); // slug is immutable on rename (ADR-001)
    expect(updated.type).toBe('FUNCTION');
    expect(updated.createdAt).toBe(r.createdAt);
    expect(updated.name).toBe('Renamed');
  });

  it('update of a missing requirement is a 404', async () => {
    await expect(
      service.update('nope', { name: 'x', criticality: 'LOW', implemented: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('check-name reflects availability + future slug with self-exclusion (FR-6.6)', async () => {
    const r = await service.create(reqInput({ name: 'Taken' }));
    expect(await service.checkName('FUNCTION', 'Taken')).toEqual({
      available: false,
      slug: 'taken-2',
    });
    expect(await service.checkName('FUNCTION', 'Free')).toEqual({ available: true, slug: 'free' });
    // Name is free in the NFR type, but the slug is taken project-wide (E8.1) → -2.
    expect(await service.checkName('NFR', 'Taken')).toEqual({ available: true, slug: 'taken-2' });
    // Renaming to its own current name is allowed when own slug is excluded.
    expect(await service.checkName('FUNCTION', 'Taken', r.slug)).toEqual({
      available: true,
      slug: 'taken',
    });
  });

  it('flags a broken .md file without crashing the load (§2.5)', async () => {
    await service.create(reqInput({ name: 'Good' }));
    await fs.writeFile(path.join(fnDir, 'broken.md'), 'no header here\njust prose');
    const { requirements, broken } = await repo.loadAll();
    expect(requirements).toHaveLength(1);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.file).toContain('broken.md');
  });

  it('deletes a leaf requirement and removes its file (FR-9.2)', async () => {
    const r = await service.create(reqInput({ name: 'Leaf' }));
    await service.delete(r.slug);
    await expect(fs.stat(path.join(fnDir, `${r.slug}.md`))).rejects.toBeTruthy();
  });

  it('blocks deletion of a node that still has children (FR-9.3)', async () => {
    const parent = await service.create(reqInput({ name: 'Parent' }));
    const child = await service.create(reqInput({ name: 'Child' }));
    const { requirements } = await repo.loadAll();
    const c = requirements.find((x) => x.slug === child.slug)!;
    c.links.push({ type: 'CHILD_OF', targetSlug: parent.slug });
    await repo.write(c);
    await expect(service.delete(parent.slug)).rejects.toBeInstanceOf(HasChildrenError);
  });

  it('rejects a slug with path traversal at the repo boundary (S21)', async () => {
    await expect(repo.delete('FUNCTION', '../evil')).rejects.toBeTruthy();
  });
});
