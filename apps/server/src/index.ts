/**
 * Public entry point of the @po/server workspace. Re-exports the use-case
 * services, filesystem repositories, error types and — crucially — the
 * composition factory and canonical input contracts so other workspaces (e.g.
 * @po/mcp) drive the domain through a stable facade, never reaching into private
 * internals (ARCH-4).
 *
 * This barrel adds no behaviour — it only surfaces existing building blocks.
 */

// HTTP app (already used by main.ts / e2e).
export { buildApp, type BuildAppOptions } from './app.js';

// Composition root (BE-1 / DIP): wire repos into services via a small context.
export {
  createProjectRepo,
  createProjectService,
  createRequirementService,
  createLinkService,
  type ServiceContext,
} from './factory.js';

// Canonical input contracts shared by REST + MCP (ARCH-4). MCP consumes these
// via the facade instead of redeclaring its own field schemas.
export {
  requirementCreateShape,
  requirementCreateSchema,
  requirementUpdateShape,
  requirementUpdateSchema,
  linkInputShape,
  linkInputSchema,
} from '@po/core';

// Structured observability (ARCH-7).
export {
  type OpLogEntry,
  type OpLogger,
  pinoOpLogger,
  stderrOpLogger,
  withOpLog,
} from './lib/logger.js';

// Services (use-case layer).
export { ProjectService, type ProjectServiceDeps } from './services/ProjectService.js';
export {
  RequirementService,
  type RequirementInput,
  type RequirementUpdate,
  type CheckNameResult,
} from './services/RequirementService.js';
export { LinkService, type LinkInput } from './services/LinkService.js';
export { ExcelExportService } from './services/ExcelExportService.js';

// Repositories (filesystem layer) + persistence ports (BE-1 / DIP).
export { FsProjectRepo, MANIFEST_PATH } from './repositories/FsProjectRepo.js';
export { FsRequirementRepo } from './repositories/FsRequirementRepo.js';
export { ArchiveRepo } from './repositories/ArchiveRepo.js';
export type {
  ProjectSummary,
  ProjectRepo,
  RequirementRepo,
  ArchivePort,
  ArchiveFormat,
  ExportResult,
  LoadResult,
  BrokenRequirement,
  RequirementBatchOp,
} from './repositories/types.js';

// Error types + HTTP mapping.
export {
  NotFoundError,
  ConflictError,
  PathSafetyError,
  ArchiveError,
  BadRequestError,
  domainErrorDetails,
  httpStatusForCode,
} from './lib/errors.js';
