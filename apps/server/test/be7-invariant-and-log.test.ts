import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeManifest, SCHEMA_VERSION } from '@po/core';
import { ArchiveRepo } from '../src/repositories/ArchiveRepo.js';
import { ProjectService } from '../src/services/ProjectService.js';
import { InvariantError } from '../src/lib/errors.js';
import type { OpLogEntry, OpLogger } from '../src/lib/logger.js';
import type { ProjectRepo, ProjectSummary, ArchivePort } from '../src/repositories/types.js';
import { cleanup, makeTmpRoot } from './helpers.js';

/** Collect every OpLogEntry emitted through the injected logger. */
function recordingLogger(sink: OpLogEntry[]): OpLogger {
  return { op: (entry) => sink.push(entry) };
}

describe('BE-7 ArchiveRepo emits a skipped-slug warning through the injected logger', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    projectDir = path.join(root, 'demo');
    await fs.mkdir(path.join(projectDir, 'openspec'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'openspec', 'project.md'),
      serializeManifest({
        name: 'demo',
        schemaVersion: SCHEMA_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('routes the "slug not found" diagnostic to the logger, not stderr', async () => {
    const entries: OpLogEntry[] = [];
    const repo = new ArchiveRepo(root, {}, recordingLogger(entries));
    await repo.exportSelected(projectDir, ['does-not-exist'], 'zip', 'demo');
    const warn = entries.find((e) => e.slug === 'does-not-exist');
    expect(warn).toBeDefined();
    expect(warn?.outcome).toBe('error');
    expect(warn?.code).toBe('NOT_FOUND');
    expect(warn?.projectId).toBe('demo');
  });

  it('does not throw when no logger is injected (silent)', async () => {
    const repo = new ArchiveRepo(root);
    await expect(
      repo.exportSelected(projectDir, ['missing'], 'zip', 'demo'),
    ).resolves.toBeDefined();
  });
});

describe('BE-7 ProjectService raises a typed InvariantError on a composition contract breach', () => {
  const project: ProjectSummary = {
    id: 'p1',
    name: 'p1',
    mainPath: '/tmp/p1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const repo: Pick<ProjectRepo, 'get'> = { get: async () => project };
  const archive = {} as ArchivePort;

  function svcWithoutRepoFactory(): ProjectService {
    return new ProjectService({
      projectsRoot: '/tmp',
      repo: repo as ProjectRepo,
      archive,
      // makeRequirementRepo intentionally omitted → composition invariant breach
    });
  }

  it('throws InvariantError (not a plain Error) when xlsx export lacks makeRequirementRepo', async () => {
    const svc = svcWithoutRepoFactory();
    await expect(svc.exportSelected('p1', ['a'], 'xlsx')).rejects.toBeInstanceOf(InvariantError);
  });

  it('throws InvariantError when a field-mask export lacks makeRequirementRepo', async () => {
    const svc = svcWithoutRepoFactory();
    await expect(svc.export('p1', 'zip', ['description'])).rejects.toBeInstanceOf(InvariantError);
  });

  it('the invariant error is NOT a DomainError (distinct from mapped runtime faults)', async () => {
    const svc = svcWithoutRepoFactory();
    const err = await svc.export('p1', 'zip', ['description']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvariantError);
    // No `code` property → the REST handler will not treat it as a mapped domain fault.
    expect((err as { code?: unknown }).code).toBeUndefined();
  });
});
