import { FsProjectRepo } from '../repositories/FsProjectRepo.js';
import { ArchiveRepo, type ArchiveFormat, type ExportResult } from '../repositories/ArchiveRepo.js';
import { type ProjectSummary } from '../repositories/types.js';
import { withProjectLock } from '../lib/projectLock.js';
import { sanitizeProjectName } from '../lib/projectName.js';

/**
 * Use-case layer for projects: listing, creation (FR-2), open (FR-4/5), and
 * archive import/export (FR-3 / FR-10). Thin orchestration over the repositories.
 */
export class ProjectService {
  private readonly repo: FsProjectRepo;
  private readonly archive: ArchiveRepo;

  constructor(
    private readonly projectsRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.repo = new FsProjectRepo(projectsRoot);
    this.archive = new ArchiveRepo(projectsRoot);
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
    const project = await this.repo.get(id); // 404 when missing
    return this.archive.export(project.mainPath, format, project.id);
  }

  /** Import an archive as a new project; returns the opened project summary.
   * Serialized on the target directory so a concurrent import/create of the
   * same name cannot race the extract→validate→rename commit (ADR-003). */
  async import(archivePath: string, name: string): Promise<ProjectSummary> {
    return withProjectLock(this.projectsRoot, sanitizeProjectName(name), async () => {
      const id = await this.archive.import(archivePath, name);
      return this.repo.get(id);
    });
  }
}
