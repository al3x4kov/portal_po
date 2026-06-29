import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('T-303 FsProjectRepo / ProjectService', () => {
  let root: string;
  let repo: FsProjectRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new FsProjectRepo(root);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('creates a project, writes a manifest and returns the Main Path (FR-5.1)', async () => {
    const p = await repo.create('My Project', fixedNow);
    expect(p.id).toBe('My Project');
    expect(p.name).toBe('My Project');
    expect(p.mainPath).toBe(path.join(root, 'My Project'));
    const manifest = JSON.parse(await fs.readFile(path.join(p.mainPath, 'project.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'My Project', schemaVersion: 1, createdAt: fixedNow() });
    expect((await fs.stat(path.join(p.mainPath, 'requirements'))).isDirectory()).toBe(true);
  });

  it('recreates Projects/ if it was deleted (FR-2.3)', async () => {
    await fs.rm(root, { recursive: true, force: true });
    const p = await repo.create('Fresh', fixedNow);
    expect((await fs.stat(p.mainPath)).isDirectory()).toBe(true);
  });

  it('rejects a duplicate project name with a conflict (FR-2.5)', async () => {
    await repo.create('Dup', fixedNow);
    await expect(repo.create('Dup', fixedNow)).rejects.toBeInstanceOf(ConflictError);
  });

  it('sanitizes illegal characters out of the directory name (NFR-5)', async () => {
    const p = await repo.create('a/b:c*?<>|"name', fixedNow);
    expect(p.id).toBe('abcname');
    expect(p.id).not.toContain('/');
    // The display name keeps the user input (trimmed).
    expect(p.name).toBe('a/b:c*?<>|"name');
  });

  it('lists created projects sorted by name', async () => {
    await repo.create('Beta', fixedNow);
    await repo.create('Alpha', fixedNow);
    const list = await repo.list();
    expect(list.map((p) => p.id)).toEqual(['Alpha', 'Beta']);
  });

  it('skips hidden directories (e.g. .import-tmp) when listing', async () => {
    await repo.create('Visible', fixedNow);
    await fs.mkdir(path.join(root, '.import-tmp'), { recursive: true });
    const list = await repo.list();
    expect(list.map((p) => p.id)).toEqual(['Visible']);
  });

  it('returns 404 for a missing project', async () => {
    await expect(repo.get('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
