import { REQUIREMENT_FOLDER, serialize, type ExportOptionalField } from '@po/core';
import { withProjectLock } from '../lib/projectLock.js';
import { sanitizeProjectName } from '../lib/projectName.js';
import { withOpLog, type OpLogger } from '../lib/logger.js';
import { InvariantError } from '../lib/errors.js';
import { ExcelExportService, XLSX_CONTENT_TYPE } from './ExcelExportService.js';
import type { ProjectServicePort } from './ports.js';
import type {
  ArchiveFormat,
  ArchivePort,
  ExportResult,
  ProjectRepo,
  ProjectSummary,
  RequirementRepo,
} from '../repositories/types.js';

/** Collaborators + configuration injected into {@link ProjectService} (BE-1 / DIP). */
export interface ProjectServiceDeps {
  /** Projects root — still needed to serialize creates/imports on the target dir. */
  projectsRoot: string;
  /** Project persistence port. */
  repo: ProjectRepo;
  /** Archive import/export port. */
  archive: ArchivePort;
  /**
   * Factory for a project's requirement repo — used to reserialize archives with
   * a field mask (Task 2). Only needed when an export carries a `fields`
   * selection; the copy/import paths do not use it.
   */
  makeRequirementRepo?: (projectId: string) => Pick<RequirementRepo, 'loadAll'>;
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
export class ProjectService implements ProjectServicePort {
  private readonly projectsRoot: string;
  private readonly repo: ProjectRepo;
  private readonly archive: ArchivePort;
  private readonly makeRequirementRepo?: (projectId: string) => Pick<RequirementRepo, 'loadAll'>;
  private readonly now: () => string;
  private readonly log?: OpLogger;

  constructor(deps: ProjectServiceDeps) {
    this.projectsRoot = deps.projectsRoot;
    this.repo = deps.repo;
    this.archive = deps.archive;
    this.makeRequirementRepo = deps.makeRequirementRepo;
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

  /**
   * Delete a project and all its files from disk (B1). Serialized on the
   * project directory so it cannot interleave with a concurrent mutation of
   * the same project (ADR-003). Requirements live inside the directory, so no
   * separate link cleanup is needed; the in-memory AI import job registry only
   * keeps status snapshots keyed by projectId and needs no purge.
   */
  deleteProject(id: string): Promise<void> {
    return withOpLog(this.log, { op: 'deleteProject', projectId: id }, () =>
      withProjectLock(this.projectsRoot, id, () => this.repo.delete(id)),
    );
  }

  /**
   * Export an existing project as a downloadable archive. `fields` selects which
   * optional sections each `.md` carries (Task 2): when omitted (`undefined`) the
   * on-disk files are copied verbatim (fast, lossless); when provided every
   * requirement is reserialized through core `serialize()` with that mask.
   */
  async export(
    id: string,
    format: ArchiveFormat,
    fields?: ExportOptionalField[],
  ): Promise<ExportResult> {
    return withOpLog(this.log, { op: 'export', projectId: id }, async () => {
      const project = await this.repo.get(id); // 404 when missing
      if (fields === undefined) {
        return this.archive.export(project.mainPath, format, project.id);
      }
      return this.exportReserialized(project, undefined, fields, format, project.id);
    });
  }

  /**
   * Export a partial archive containing only the listed requirement slugs plus
   * the project manifest (T-523). Unknown slugs are silently ignored. When
   * `fields` is given, the selected requirements are reserialized with that mask
   * (Task 2) and links pointing at excluded slugs are dropped so the archive
   * stays internally consistent and re-imports cleanly.
   *
   * With `format: 'xlsx'` a human-readable workbook is produced instead of an
   * archive: it contains ONLY the selected slugs (unlike GET /export.xlsx, which
   * exports every requirement) with the `fields` column selection applied.
   */
  async exportSelected(
    id: string,
    slugs: string[],
    format: 'xlsx' | ArchiveFormat,
    fields?: ExportOptionalField[],
  ): Promise<ExportResult> {
    return withOpLog(this.log, { op: 'exportSelected', projectId: id }, async () => {
      const project = await this.repo.get(id); // 404 when missing
      if (format === 'xlsx') {
        if (!this.makeRequirementRepo) {
          throw new InvariantError('makeRequirementRepo is required to export xlsx.');
        }
        const { requirements } = await this.makeRequirementRepo(project.id).loadAll();
        const selected = new Set(slugs);
        const included = requirements.filter((r) => selected.has(r.slug));
        const body = await ExcelExportService.buildWorkbook(included, fields);
        return { body, filename: `${project.id}.xlsx`, contentType: XLSX_CONTENT_TYPE };
      }
      if (fields === undefined) {
        return this.archive.exportSelected(project.mainPath, slugs, format, project.id);
      }
      return this.exportReserialized(
        project,
        new Set(slugs),
        fields,
        format,
        `${project.id}-partial`,
      );
    });
  }

  /**
   * Reserialize a project's requirements with a field mask and pack them (Task 2).
   * `slugFilter` restricts the set (partial export); when it excludes a link's
   * target the link is dropped so no dangling reference reaches the archive.
   */
  private async exportReserialized(
    project: ProjectSummary,
    slugFilter: Set<string> | undefined,
    fields: ExportOptionalField[],
    format: ArchiveFormat,
    baseName: string,
  ): Promise<ExportResult> {
    if (!this.makeRequirementRepo) {
      throw new InvariantError('makeRequirementRepo is required to export with a field mask.');
    }
    const { requirements } = await this.makeRequirementRepo(project.id).loadAll();
    const included = slugFilter ? requirements.filter((r) => slugFilter.has(r.slug)) : requirements;
    const includedSlugs = new Set(included.map((r) => r.slug));

    const files = included.map((req) => ({
      rel: `openspec/specs/${REQUIREMENT_FOLDER[req.type]}/${req.slug}.md`,
      content: serialize(
        { ...req, links: req.links.filter((l) => includedSlugs.has(l.targetSlug)) },
        { fields },
      ),
    }));

    return this.archive.packReserialized(files, project.mainPath, format, baseName);
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
