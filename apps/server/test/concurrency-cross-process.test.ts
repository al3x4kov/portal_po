import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '@po/core';
import { FsProjectRepo, MANIFEST_PATH } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { ArchiveRepo } from '../src/repositories/ArchiveRepo.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

/**
 * QA-1: REAL cross-PROCESS contention on a shared `PROJECTS_ROOT`.
 *
 * The existing `concurrency.test.ts` only proves serialization *within one
 * event loop*. `withProjectLock` (proper-lockfile, ADR-003) exists for the
 * harder case the product actually ships: the REST server and the `/po` MCP
 * server are separate OS processes writing to the SAME root. Two Promises in
 * one process share proper-lockfile's in-memory registry; two *processes* do
 * not — they can only agree through the on-disk `.lock` marker. This suite
 * spawns independent `child_process.fork` workers so the lock, and nothing
 * else, is what prevents lost updates / duplicate slugs / half-written files.
 *
 * Workers import the BUILT server (`apps/server/dist`), so we build first and
 * run the exact code path production uses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workerPath = path.join(here, 'concurrency-cross-process.worker.mjs');

interface WorkerReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Run one task in a genuinely separate OS process; resolve with its single reply. */
function runWorker(task: unknown): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let replied = false;
    const timer = setTimeout(() => {
      if (!replied) {
        child.kill('SIGKILL');
        reject(new Error('worker timed out'));
      }
    }, 30_000);
    child.on('message', (msg) => {
      replied = true;
      clearTimeout(timer);
      resolve(msg as WorkerReply);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (!replied) {
        clearTimeout(timer);
        reject(new Error(`worker exited (${code}) without replying`));
      }
    });
    child.send(task);
  });
}

describe('QA-1 cross-process serialization on a shared PROJECTS_ROOT (ADR-003)', () => {
  const roots: string[] = [];

  async function freshRoot(): Promise<string> {
    const root = await makeTmpRoot();
    roots.push(root);
    return root;
  }

  beforeAll(() => {
    // Build so the workers import the CURRENT lock implementation, not a stale
    // dist. Incremental `tsc -b` is a no-op when already built (~0.4s).
    execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-b', 'apps/server'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }, 120_000);

  afterEach(async () => {
    while (roots.length) {
      await cleanup(roots.pop()!);
    }
  });

  it('two processes creating slug-colliding requirements → 8 unique slugs, none lost, none broken', async () => {
    const root = await freshRoot();
    const projectId = (await new FsProjectRepo(root).create('Proj', fixedNow)).id;

    // Distinct names (each passes name-uniqueness) that all slugify to
    // "proj-req" — the read-modify-write race the lock exists to serialize.
    // Split disjointly across two independent processes.
    const suffixes = ['', '.', '!', '?', ',', ';', ':', '*'];
    const names = suffixes.map((s) => `Proj Req${s}`);
    const mid = names.length / 2;
    const toInputs = (ns: string[]) => ns.map((name) => reqInput({ name }));

    const [a, b] = await Promise.all([
      runWorker({
        kind: 'create-requirements',
        projectsRoot: root,
        projectId,
        inputs: toInputs(names.slice(0, mid)),
      }),
      runWorker({
        kind: 'create-requirements',
        projectsRoot: root,
        projectId,
        inputs: toInputs(names.slice(mid)),
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const perCall = [
      ...(a.result as { ok: boolean; slug?: string; error?: string }[]),
      ...(b.result as { ok: boolean; slug?: string; error?: string }[]),
    ];
    // Every single create succeeded across both processes (no 409/clobber).
    expect(perCall.every((r) => r.ok)).toBe(true);
    const returnedSlugs = perCall.map((r) => r.slug);
    expect(new Set(returnedSlugs).size).toBe(names.length);

    // On-disk truth: nothing clobbered, nothing lost, no duplicate slug.
    const { requirements, broken } = await new FsRequirementRepo(root, projectId).loadAll();
    expect(broken).toEqual([]);
    expect(requirements).toHaveLength(names.length);
    const slugs = requirements.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(names.length);
    expect(slugs).toContain('proj-req');
    expect(slugs).toContain('proj-req-2');
    expect(slugs).toContain(`proj-req-${names.length}`);

    const raw = await fs.readFile(path.join(root, projectId, MANIFEST_PATH), 'utf8');
    expect(parseManifest(raw).name).toBe('Proj');
  }, 60_000);

  it('two processes updating one requirement concurrently → single consistent file, no corruption', async () => {
    const root = await freshRoot();
    const projectId = (await new FsProjectRepo(root).create('Proj', fixedNow)).id;
    const seed = await new RequirementService(
      new FsRequirementRepo(root, projectId),
      fixedNow,
    ).create(reqInput({ name: 'Target' }));

    const updates = (crit: 'HIGH' | 'LOW') =>
      Array.from({ length: 5 }, () => reqInput({ name: 'Target', criticality: crit }));

    const [a, b] = await Promise.all([
      runWorker({
        kind: 'update-requirement',
        projectsRoot: root,
        projectId,
        slug: seed.slug,
        updates: updates('HIGH'),
      }),
      runWorker({
        kind: 'update-requirement',
        projectsRoot: root,
        projectId,
        slug: seed.slug,
        updates: updates('LOW'),
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const { requirements, broken } = await new FsRequirementRepo(root, projectId).loadAll();
    expect(broken).toEqual([]);
    const only = requirements.filter((r) => r.slug === seed.slug);
    expect(only).toHaveLength(1); // never duplicated or lost
    expect(['HIGH', 'LOW']).toContain(only[0]!.criticality); // a whole, valid value
  }, 60_000);

  it('import and create racing for the SAME project name → exactly one wins, result uncorrupted', async () => {
    const root = await freshRoot();

    // Build a real archive fixture (a valid 2-requirement project) to import.
    const archivePath = await buildSeedArchive(root);
    const NAME = 'Contended';

    const [imp, cre] = await Promise.all([
      runWorker({ kind: 'project-import', projectsRoot: root, archivePath, name: NAME }),
      runWorker({ kind: 'project-create', projectsRoot: root, name: NAME }),
    ]);

    // Exactly one mutation committed; the loser got a typed conflict.
    const winners = [imp, cre].filter((r) => r.ok);
    const losers = [imp, cre].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.error ?? '').toMatch(/already exists/i);

    const winnerId = (winners[0]!.result as { id: string }).id;

    // The surviving project is coherent regardless of who won: no half-import
    // interleaved with the scaffold.
    const { requirements, broken } = await new FsRequirementRepo(root, winnerId).loadAll();
    expect(broken).toEqual([]);
    expect(requirements).toHaveLength(imp.ok ? 2 : 0); // import → 2 reqs, create → empty
    const raw = await fs.readFile(path.join(root, winnerId, MANIFEST_PATH), 'utf8');
    expect(parseManifest(raw)).toBeTruthy();
  }, 60_000);

  it('import and create of DIFFERENT projects run in parallel on one root without corrupting it', async () => {
    const root = await freshRoot();
    const archivePath = await buildSeedArchive(root);

    const [imp, cre] = await Promise.all([
      runWorker({ kind: 'project-import', projectsRoot: root, archivePath, name: 'Imported' }),
      runWorker({ kind: 'project-create', projectsRoot: root, name: 'Created' }),
    ]);

    expect(imp.ok).toBe(true);
    expect(cre.ok).toBe(true);
    const importedId = (imp.result as { id: string }).id;
    const createdId = (cre.result as { id: string }).id;

    const imported = await new FsRequirementRepo(root, importedId).loadAll();
    expect(imported.broken).toEqual([]);
    expect(imported.requirements).toHaveLength(2);

    const created = await new FsRequirementRepo(root, createdId).loadAll();
    expect(created.broken).toEqual([]);
    expect(created.requirements).toHaveLength(0);

    // Both manifests are intact — the shared root / `.locks` dir survived.
    for (const id of [importedId, createdId]) {
      const raw = await fs.readFile(path.join(root, id, MANIFEST_PATH), 'utf8');
      expect(parseManifest(raw)).toBeTruthy();
    }
  }, 60_000);
});

/**
 * Seed a valid 2-requirement project inside `root`, export it to a zip file
 * (placed outside `root` so it is not mistaken for a project), and return the
 * archive path for import tasks.
 */
async function buildSeedArchive(root: string): Promise<string> {
  const seedId = (await new FsProjectRepo(root).create('Seed', fixedNow)).id;
  const svc = new RequirementService(new FsRequirementRepo(root, seedId), fixedNow);
  await svc.create(reqInput({ name: 'Seed One' }));
  await svc.create(reqInput({ name: 'Seed Two' }));

  const seedDir = path.join(root, seedId);
  const { body } = await new ArchiveRepo(root).export(seedDir, 'zip', 'seed');
  const archivePath = path.join(path.dirname(root), 'seed-fixture.zip');
  await fs.writeFile(archivePath, body as Buffer);

  // Remove the seed project so it never collides with import/create targets.
  await fs.rm(seedDir, { recursive: true, force: true });
  return archivePath;
}
