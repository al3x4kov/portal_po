import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { linkInputSchema } from '@po/core';
import { createLinkService, createProjectRepo, type ServiceContext } from '../factory.js';
import type { LinkService } from '../services/LinkService.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/**
 * Request body for creating/removing a link. Canonical contract shared verbatim
 * with the MCP `link_requirements` tool (ARCH-4); re-exported here for the
 * OpenAPI generator.
 */
export const linkBody = linkInputSchema;

/** Path params (BE-6): zod-validated instead of unchecked `as {…}` casts. */
const idParams = z.object({ id: z.string().min(1) });

/** Link create/delete routes (T-404): POST/DELETE /api/projects/:id/links. */
export async function linkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const projectRepo = createProjectRepo(ctx);

  const serviceFor = async (projectId: string): Promise<LinkService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return createLinkService(ctx, projectId);
  };

  app.post('/api/projects/:id/links', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(linkBody, req.body);
    const service = await serviceFor(id);
    await service.create(body);
    reply.code(201);
    return { ok: true };
  });

  app.delete('/api/projects/:id/links', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(linkBody, req.body);
    const service = await serviceFor(id);
    await service.remove(body);
    return { ok: true };
  });
}
