import { ProjectService } from './services/ProjectService.js';
import { RequirementService } from './services/RequirementService.js';
import { LinkService } from './services/LinkService.js';
import { FsProjectRepo } from './repositories/FsProjectRepo.js';
import { FsRequirementRepo } from './repositories/FsRequirementRepo.js';
import { ArchiveRepo } from './repositories/ArchiveRepo.js';
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
}

/** Project persistence port, wired to the filesystem. */
export function createProjectRepo(ctx: ServiceContext): FsProjectRepo {
  return new FsProjectRepo(ctx.projectsRoot);
}

/** Project use-case service, with repo + archive composed in. */
export function createProjectService(ctx: ServiceContext): ProjectService {
  return new ProjectService({
    projectsRoot: ctx.projectsRoot,
    repo: new FsProjectRepo(ctx.projectsRoot),
    archive: new ArchiveRepo(ctx.projectsRoot),
    now: ctx.now,
    log: ctx.log,
  });
}

/** Requirement use-case service for one project. */
export function createRequirementService(
  ctx: ServiceContext,
  projectId: string,
): RequirementService {
  return new RequirementService(new FsRequirementRepo(ctx.projectsRoot, projectId), ctx.now, {
    log: ctx.log,
    projectId,
  });
}

/** Link use-case service for one project. */
export function createLinkService(ctx: ServiceContext, projectId: string): LinkService {
  return new LinkService(new FsRequirementRepo(ctx.projectsRoot, projectId), ctx.now, {
    log: ctx.log,
    projectId,
  });
}
