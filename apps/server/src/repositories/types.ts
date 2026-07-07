import type { Readable } from 'node:stream';
import type { Requirement, RequirementType } from '@po/core';

export { SCHEMA_VERSION, type ProjectManifest } from '@po/core';

/** Project descriptor returned by the API (id === sanitized directory name). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Absolute filesystem path of the project directory (FR-5.1 "Main Path"). */
  mainPath: string;
  createdAt: string;
}

/** A `.md` file that could not be parsed into a valid Requirement (flagged, not fatal). */
export interface BrokenRequirement {
  /** Path relative to `openspec/specs` (e.g. `functions/foo.md`). */
  file: string;
  /** File name without the `.md` extension — occupies a slug on disk (ARCH-3). */
  slug: string;
  error: string;
}

/** Result of loading every requirement file in a project. */
export interface LoadResult {
  requirements: Requirement[];
  broken: BrokenRequirement[];
  /**
   * Slugs of requirements that lack a complete acceptance criterion (SA-4):
   * either no scenarios at all, or at least one incomplete scenario (missing
   * WHEN/THEN). Scenarios are the sole carrier of acceptance criteria (ADR — no
   * separate `fitCriterion` field on the model); this derived flag lets the
   * REST/MCP clients surface "requirement without acceptance criterion".
   */
  incomplete: string[];
}

/**
 * A single file mutation inside a transactional batch: a `write` upserts a
 * requirement file, a `delete` removes one. Applied all-or-nothing by
 * {@link RequirementRepo.applyBatch}.
 */
export type RequirementBatchOp =
  { kind: 'write'; req: Requirement } | { kind: 'delete'; type: RequirementType; slug: string };

/**
 * Persistence port for the requirement files of a single project (BE-1 / DIP).
 * Services depend on this interface, not on the concrete filesystem class, so
 * they can be unit-tested with an in-memory fake and are decoupled from I/O.
 */
export interface RequirementRepo {
  /** Run `fn` while holding the cross-process project lock (ADR-003). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Read + parse every requirement; corrupt files are reported, not thrown. */
  loadAll(): Promise<LoadResult>;
  /** Create or overwrite a single requirement file atomically. */
  write(req: Requirement): Promise<void>;
  /** Delete a requirement file (identified by type + slug). */
  delete(type: RequirementType, slug: string): Promise<void>;
  /** Apply a group of file mutations transactionally (all-or-nothing). */
  applyBatch(ops: readonly RequirementBatchOp[]): Promise<void>;
}

/** Persistence port for projects (BE-1 / DIP). */
export interface ProjectRepo {
  ensureRoot(): Promise<void>;
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectSummary>;
  exists(id: string): Promise<boolean>;
  create(rawName: string, now?: () => string): Promise<ProjectSummary>;
  /** Recursively delete a project directory (and thus all its requirements). */
  delete(id: string): Promise<void>;
}

export type ArchiveFormat = 'zip' | 'targz';

export interface ExportResult {
  body: Buffer | Readable;
  filename: string;
  contentType: string;
}

/** Archive import/export port (BE-1 / DIP). */
export interface ArchivePort {
  export(projectDir: string, format: ArchiveFormat, baseName: string): Promise<ExportResult>;
  import(archivePath: string, rawName: string): Promise<string>;
  /**
   * Build a partial archive containing only the specified slugs + the project
   * manifest (T-523). Missing slugs are silently skipped; on-disk `.md` files
   * are copied verbatim.
   */
  exportSelected(
    projectDir: string,
    slugs: string[],
    format: ArchiveFormat,
    baseName: string,
  ): Promise<ExportResult>;
  /**
   * Pack a set of already-serialized files into an archive (T-202). Unlike
   * {@link ArchivePort.export}/{@link ArchivePort.exportSelected}, the content is
   * supplied by the caller (reserialized through core `serialize()` with a field
   * mask); the project manifest is read from `projectDir` and included when present.
   */
  packReserialized(
    files: ReadonlyArray<{ rel: string; content: string }>,
    projectDir: string,
    format: ArchiveFormat,
    baseName: string,
  ): Promise<ExportResult>;
}
