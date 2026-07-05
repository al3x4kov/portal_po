import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { NotFoundError, PathSafetyError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('B1 FsProjectRepo.delete', () => {
  let root: string;
  let repo: FsProjectRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new FsProjectRepo(root);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('recursively removes the project directory with all its files', async () => {
    const p = await repo.create('Doomed', fixedNow);
    // Simulate a requirement file inside the project tree.
    const reqFile = path.join(p.mainPath, 'openspec', 'specs', 'functions', 'ft-1.md');
    await fs.writeFile(reqFile, '# ft-1', 'utf8');

    await repo.delete('Doomed');

    await expect(fs.stat(p.mainPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repo.exists('Doomed')).toBe(false);
  });

  it('does not touch sibling projects', async () => {
    await repo.create('Keep', fixedNow);
    await repo.create('Drop', fixedNow);

    await repo.delete('Drop');

    const list = await repo.list();
    expect(list.map((p) => p.id)).toEqual(['Keep']);
  });

  it('throws NotFoundError for a missing project', async () => {
    await expect(repo.delete('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError on repeated delete', async () => {
    await repo.create('Once', fixedNow);
    await repo.delete('Once');
    await expect(repo.delete('Once')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects path traversal ids and leaves the outside directory intact (NFR-5)', async () => {
    // A directory OUTSIDE the projects root that a traversal id points at.
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep', 'utf8');
    try {
      const traversalId = `../${path.basename(outside)}`;
      await expect(repo.delete(traversalId)).rejects.toBeInstanceOf(PathSafetyError);
      // The outside directory must be untouched.
      expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an absolute path id (NFR-5)', async () => {
    await expect(repo.delete(path.resolve(root, '..'))).rejects.toBeInstanceOf(PathSafetyError);
  });
});

describe('B1 DELETE /api/projects/:id (HTTP integration)', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('deletes an existing project → 204, no body, gone from the list', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Demo' } });

    const res = await app.inject({ method: 'DELETE', url: '/api/projects/Demo' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    await expect(fs.stat(path.join(root, 'Demo'))).rejects.toMatchObject({ code: 'ENOENT' });

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toEqual([]);

    const get = await app.inject({ method: 'GET', url: '/api/projects/Demo' });
    expect(get.statusCode).toBe(404);
  });

  it('returns 404 for a missing project', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('returns 404 on repeated delete', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Twice' } });
    const first = await app.inject({ method: 'DELETE', url: '/api/projects/Twice' });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: 'DELETE', url: '/api/projects/Twice' });
    expect(second.statusCode).toBe(404);
    expect(second.json().code).toBe('NOT_FOUND');
  });

  it('rejects path traversal in :id with 400 (NFR-5)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/..%2Fescape' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PATH_UNSAFE');
    // The projects root itself must still exist.
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });

  it('does not delete sibling projects', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Alpha' } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Beta' } });

    await app.inject({ method: 'DELETE', url: '/api/projects/Alpha' });

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().map((p: { id: string }) => p.id)).toEqual(['Beta']);
  });
});
