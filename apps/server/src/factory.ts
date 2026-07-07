import { ProjectService } from './services/ProjectService.js';
import { RequirementService } from './services/RequirementService.js';
import { LinkService } from './services/LinkService.js';
import { FsProjectRepo } from './repositories/FsProjectRepo.js';
import { FsRequirementRepo } from './repositories/FsRequirementRepo.js';
import { ArchiveRepo } from './repositories/ArchiveRepo.js';
import { AiConfigRepo } from './repositories/AiConfigRepo.js';
import { AiHubService, type AiClientFactory } from './services/AiHubService.js';
import { AiImportService } from './services/AiImportService.js';
import type { AiImportJobs } from './services/AiImportJobs.js';
import { createOpenAiClientFactory } from './services/openaiClient.js';
import type {
  LinkServicePort,
  ProjectServicePort,
  RequirementServicePort,
} from './services/ports.js';
import type { OpLogger } from './lib/logger.js';

/**
 * Composition root (BE-1 / DIP): the single place that wires concrete
 * filesystem repositories + the archive port into the use-case services. Routes
 * and MCP tools request services from here rather than `new`-ing repositories
 * inline, so the services stay decoupled from their persistence collaborators.
 */
export interface ServiceContext {
  projectsRoot: string;
  now: () => string;
  log?: OpLogger;
  /**
   * Optional AI client factory injection point. Tests pass a mock; when absent
   * the production `openai`-backed factory is used (Task 8).
   */
  makeAiClient?: AiClientFactory;
}

/** Project persistence port, wired to the filesystem. */
export function createProjectRepo(ctx: ServiceContext): FsProjectRepo {
  return new FsProjectRepo(ctx.projectsRoot);
}

/** Project use-case service, with repo + archive composed in (facade: {@link ProjectServicePort}). */
export function createProjectService(ctx: ServiceContext): ProjectServicePort {
  return new ProjectService({
    projectsRoot: ctx.projectsRoot,
    repo: new FsProjectRepo(ctx.projectsRoot),
    archive: new ArchiveRepo(ctx.projectsRoot, {}, ctx.log),
    makeRequirementRepo: (projectId) => new FsRequirementRepo(ctx.projectsRoot, projectId),
    now: ctx.now,
    log: ctx.log,
  });
}

/** Requirement use-case service for one project. */
export function createRequirementService(
  ctx: ServiceContext,
  projectId: string,
): RequirementServicePort {
  return new RequirementService(new FsRequirementRepo(ctx.projectsRoot, projectId), ctx.now, {
    log: ctx.log,
    projectId,
  });
}

/** Link use-case service for one project. */
export function createLinkService(ctx: ServiceContext, projectId: string): LinkServicePort {
  return new LinkService(new FsRequirementRepo(ctx.projectsRoot, projectId), ctx.now, {
    log: ctx.log,
    projectId,
  });
}

/** Global AI Hub config repository (single `.ai-config.json` under the root). */
export function createAiConfigRepo(ctx: ServiceContext): AiConfigRepo {
  return new AiConfigRepo(ctx.projectsRoot);
}

/**
 * AI Hub service, wired to the config repo and a client factory. Uses the
 * injected `makeAiClient` when present (tests), otherwise the real `openai`
 * wrapper (production).
 */
export function createAiHubService(ctx: ServiceContext): AiHubService {
  return new AiHubService({
    repo: new AiConfigRepo(ctx.projectsRoot),
    makeClient: ctx.makeAiClient ?? createOpenAiClientFactory(),
    log: ctx.log,
  });
}

/**
 * AI-import use-case service (BE-6). The composition root owns the full wiring —
 * config repo, requirement/link service factories, project-existence check —
 * and the prod/mock client choice (`ctx.makeAiClient` in tests, the real
 * `openai` wrapper otherwise), so the route no longer `new`s the service or
 * reaches for `createOpenAiClientFactory` itself. The job registry is passed in
 * because it is owned per app instance (its lifetime spans many requests).
 */
export function createAiImportService(ctx: ServiceContext, jobs: AiImportJobs): AiImportService {
  const projectRepo = new FsProjectRepo(ctx.projectsRoot);
  return new AiImportService({
    now: ctx.now,
    jobs,
    configRepo: new AiConfigRepo(ctx.projectsRoot),
    makeAiClient: ctx.makeAiClient ?? createOpenAiClientFactory(),
    makeRequirementService: (projectId) => createRequirementService(ctx, projectId),
    makeLinkService: (projectId) => createLinkService(ctx, projectId),
    projectExists: (projectId) => projectRepo.exists(projectId),
    log: ctx.log,
  });
}
