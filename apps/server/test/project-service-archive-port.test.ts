import { describe, expect, it, vi } from 'vitest';
import { ProjectService } from '../src/services/ProjectService.js';
import type {
  ArchiveFormat,
  ArchivePort,
  ExportResult,
  ProjectRepo,
  ProjectSummary,
} from '../src/repositories/types.js';

/**
 * BE-2: ProjectService must talk to the archive strictly through the
 * {@link ArchivePort} abstraction — no downcast to the concrete `ArchiveRepo`.
 * These tests inject a hand-written fake port (which does NOT extend
 * `ArchiveRepo`) and assert the reserialize/partial-export code paths route
 * through the port's `exportSelected` / `packReserialized` methods.
 */

const SUMMARY: ProjectSummary = {
  id: 'Demo',
  name: 'Demo',
  mainPath: '/tmp/Projects/Demo',
  createdAt: '2020-01-01T00:00:00.000Z',
};

const RESULT: ExportResult = {
  body: Buffer.from('archive'),
  filename: 'Demo.zip',
  contentType: 'application/zip',
};

function fakeProjectRepo(): ProjectRepo {
  return {
    ensureRoot: vi.fn(async () => {}),
    list: vi.fn(async () => [SUMMARY]),
    get: vi.fn(async () => SUMMARY),
    exists: vi.fn(async () => true),
    create: vi.fn(async () => SUMMARY),
    delete: vi.fn(async () => {}),
  };
}

/** A pure in-memory ArchivePort — deliberately NOT an `ArchiveRepo` instance. */
function fakeArchivePort(): ArchivePort {
  return {
    export: vi.fn(async () => RESULT),
    import: vi.fn(async () => SUMMARY.id),
    exportSelected: vi.fn(async () => RESULT),
    packReserialized: vi.fn(async () => RESULT),
  };
}

describe('BE-2 ProjectService talks to the archive through ArchivePort only', () => {
  it('exportSelected (no fields) routes to ArchivePort.exportSelected', async () => {
    const archive = fakeArchivePort();
    const svc = new ProjectService({
      projectsRoot: '/tmp/Projects',
      repo: fakeProjectRepo(),
      archive,
    });

    const out = await svc.exportSelected('Demo', ['a', 'b'], 'zip' as ArchiveFormat);

    expect(out).toBe(RESULT);
    expect(archive.exportSelected).toHaveBeenCalledWith(
      SUMMARY.mainPath,
      ['a', 'b'],
      'zip',
      'Demo',
    );
    expect(archive.packReserialized).not.toHaveBeenCalled();
  });

  it('export with a field mask reserializes through ArchivePort.packReserialized', async () => {
    const archive = fakeArchivePort();
    const svc = new ProjectService({
      projectsRoot: '/tmp/Projects',
      repo: fakeProjectRepo(),
      archive,
      // No requirements → the reserialized file list is empty; we only assert routing.
      makeRequirementRepo: () => ({
        loadAll: vi.fn(async () => ({ requirements: [], broken: [], incomplete: [] })),
      }),
    });

    const out = await svc.export('Demo', 'zip' as ArchiveFormat, ['links']);

    expect(out).toBe(RESULT);
    expect(archive.packReserialized).toHaveBeenCalledTimes(1);
    const [files, dir, format, baseName] = (archive.packReserialized as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(files).toEqual([]);
    expect(dir).toBe(SUMMARY.mainPath);
    expect(format).toBe('zip');
    expect(baseName).toBe('Demo');
    expect(archive.export).not.toHaveBeenCalled();
  });
});
