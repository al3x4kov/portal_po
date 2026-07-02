/**
 * Public entry point of the @po/server workspace. Re-exports the use-case
 * services, filesystem repositories and error types so other workspaces (e.g.
 * @po/mcp) can drive the domain directly, without going through HTTP.
 *
 * This barrel adds no behaviour — it only surfaces existing building blocks.
 */

// HTTP app (already used by main.ts / e2e).
export { buildApp, type BuildAppOptions } from './app.js';

// Services (use-case layer).
export { ProjectService } from './services/ProjectService.js';
export {
  RequirementService,
  type RequirementInput,
  type RequirementUpdate,
  type CheckNameResult,
} from './services/RequirementService.js';
export { LinkService, type LinkInput } from './services/LinkService.js';
export { ExcelExportService } from './services/ExcelExportService.js';

// Repositories (filesystem layer).
export { FsProjectRepo, MANIFEST_PATH } from './repositories/FsProjectRepo.js';
export {
  FsRequirementRepo,
  type LoadResult,
  type BrokenRequirement,
} from './repositories/FsRequirementRepo.js';
export { ArchiveRepo, type ArchiveFormat, type ExportResult } from './repositories/ArchiveRepo.js';
export type { ProjectSummary } from './repositories/types.js';

// Error types + HTTP mapping.
export {
  NotFoundError,
  ConflictError,
  PathSafetyError,
  ArchiveError,
  httpStatusForCode,
} from './lib/errors.js';
