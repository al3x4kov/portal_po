import { withProjectLock } from '../lib/projectLock.js';
import { sanitizeProjectName } from '../lib/projectName.js';
import { withOpLog, type OpLogger } from '../lib/logger.js';
import type {
  ArchiveFormat,
  ArchivePort,
  ExportResult,
  ProjectRepo,
  ProjectSummary,
} from '../repositories/types.js';

/** Collaborators + configuration injected into {@link ProjectService} (BE-1 / DIP). */
export interface ProjectServiceDeps {
  /** Projects root — still needed to serialize creates/imports on the target dir. */
  projectsRoot: string;
  /** Project persistence port. */
  repo: ProjectRepo;
  /** Archive import/export port. */
  archive: ArchivePort;
  /** Clock for deterministic timestamps in tests. */
  now?: () => string;
  /** Optional structured logger (ARCH-7). */
  log?: OpLogger;
}

/**
 * Use-case layer for projects: listing, creation (FR-2), open (FR-4/5), and
 * archive import/export (FR-3 / FR-10). Thin orchestration over the injected
 * repository + archive ports (BE-1) — it constructs none of its collaborators.
 */
export class ProjectService {
  private readonly projectsRoot: string;
  private readonly repo: ProjectRepo;
  private readonly archive: ArchivePort;
  private readonly now: () => string;
  private readonly log?: OpLogger;

  constructor(deps: ProjectServiceDeps) {
    this.projectsRoot = deps.projectsRoot;
    this.repo = deps.repo;
    this.archive = deps.archive;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.log = deps.log;
  }

  list(): Promise<ProjectSummary[]> {
    return this.repo.list();
  }

  get(id: string): Promise<ProjectSummary> {
    return this.repo.get(id);
  }

  /** Create a project; serialized on its target directory so concurrent
   * same-name creates cannot both scaffold the same folder (ADR-003). */
  create(name: string): Promise<ProjectSummary> {
    return withProjectLock(this.projectsRoot, sanitizeProjectName(name), () =>
      this.repo.create(name, this.now),
    );
  }

  /** Export an existing project as a downloadable archive. */
  async export(id: string, format: ArchiveFormat): Promise<ExportResult> {
    return withOpLog(this.log, { op: 'export', projectId: id }, async () => {
      const project = await this.repo.get(id); // 404 when missing
      return this.archive.export(project.mainPath, format, project.id);
    });
  }

  /** Import an archive as a new project; returns the opened project summary.
   * Serialized on the target directory so a concurrent import/create of the
   * same name cannot race the extract→validate→rename commit (ADR-003). */
  async import(archivePath: string, name: string): Promise<ProjectSummary> {
    const id = sanitizeProjectName(name);
    return withOpLog(this.log, { op: 'import', projectId: id }, () =>
      withProjectLock(this.projectsRoot, id, async () => {
        const importedId = await this.archive.import(archivePath, name);
        return this.repo.get(importedId);
      }),
    );
  }
}
