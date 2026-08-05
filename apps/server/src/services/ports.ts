import type { ExportOptionalField, Requirement, RequirementType } from '@po/core';
import type {
  ArchiveFormat,
  ExportResult,
  LoadResult,
  ProjectSummary,
} from '../repositories/types.js';
import type { CheckNameResult, RequirementInput, RequirementUpdate } from './RequirementService.js';
import type { LinkInput, MoveInput, MoveResult } from './LinkService.js';

/**
 * Service facade contracts (ARCH-9). These interfaces are the STABLE public
 * surface of the use-case layer that the three adapters above the domain core —
 * REST routes, MCP tools (ADR-002), and {@link AiImportService} — depend on.
 *
 * Adapters and factories are typed against these ports rather than the concrete
 * service classes, and each class `implements` its port. The compiler then
 * guarantees both directions: a class can never drift below the contract, and
 * an adapter can never quietly start relying on a private/concrete-only member.
 * A change to a service's PRIVATE surface is invisible here; a change to its
 * PUBLIC surface must go through the port, which surfaces all three consumers.
 *
 * The interfaces cover only the methods the adapters actually call — nothing
 * more (no private helpers, no constructor wiring).
 */

/** Requirement use-case surface consumed by REST, MCP and AI-import. */
export interface RequirementServicePort {
  /** List every requirement of the project (plus broken/incomplete diagnostics). */
  list(): Promise<LoadResult>;
  /** Real-time name-availability check (FR-6.6); excludes own slug on rename. */
  checkName(type: RequirementType, name: string, excludeSlug?: string): Promise<CheckNameResult>;
  /** Create a requirement (FR-6). */
  create(input: RequirementInput): Promise<Requirement>;
  /** Update a requirement (FR-6.5); slug/type immutable. */
  update(slug: string, input: RequirementUpdate): Promise<Requirement>;
  /** Delete a requirement, optionally cascading its subtree (FR-9); returns removed slugs. */
  delete(slug: string, opts?: { cascade?: boolean }): Promise<{ deleted: string[] }>;
}

/** Link use-case surface consumed by REST, MCP and AI-import. */
export interface LinkServicePort {
  /** Create a link and its inverse (FR-8). */
  create(input: LinkInput): Promise<void>;
  /** Remove a link and its inverse (FR-8). */
  remove(input: LinkInput): Promise<void>;
  /** Re-parent a requirement — the whole of «move a row in the tree» (FR-7). */
  move(input: MoveInput): Promise<MoveResult>;
}

/** Project use-case surface consumed by REST and MCP. */
export interface ProjectServicePort {
  /** List all projects (FR-1). */
  list(): Promise<ProjectSummary[]>;
  /** Get one project by id (FR-4/5). */
  get(id: string): Promise<ProjectSummary>;
  /** Create a project (FR-2). */
  create(name: string): Promise<ProjectSummary>;
  /** Delete a project and all its files (B1). */
  deleteProject(id: string): Promise<void>;
  /** Export a project as a downloadable archive (FR-10), optional field mask. */
  export(id: string, format: ArchiveFormat, fields?: ExportOptionalField[]): Promise<ExportResult>;
  /** Export a subset of requirements as an archive or xlsx workbook (T-523). */
  exportSelected(
    id: string,
    slugs: string[],
    format: 'xlsx' | ArchiveFormat,
    fields?: ExportOptionalField[],
  ): Promise<ExportResult>;
  /** Import an archive as a new project (FR-3); returns the opened summary. */
  import(archivePath: string, name: string): Promise<ProjectSummary>;
}
