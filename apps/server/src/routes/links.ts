import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { linkInputSchema, moveRequirementSchema } from '@po/core';
import { createLinkService, createProjectRepo, type ServiceContext } from '../factory.js';
import type { LinkServicePort } from '../services/ports.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/**
 * Request body for creating/removing a link. Canonical contract shared verbatim
 * with the MCP `link_requirements` tool (ARCH-4); re-exported here for the
 * OpenAPI generator.
 */
export const linkBody = linkInputSchema;

/** Body of the move endpoint; the contract lives in `@po/core`. */
export const moveBody = moveRequirementSchema;

/** Path params (BE-6): zod-validated instead of unchecked `as {…}` casts. */
const idParams = z.object({ id: z.string().min(1) });

/** Path params of the move endpoint: project id + requirement slug. */
const moveParams = z.object({ id: z.string().min(1), rid: z.string().min(1) });

/** Link create/delete routes (T-404): POST/DELETE /api/projects/:id/links. */
export async function linkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const projectRepo = createProjectRepo(ctx);

  const serviceFor = async (projectId: string): Promise<LinkServicePort> => {
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

  /**
   * Move a requirement in the tree: PUT /api/projects/:id/requirements/:rid/parent.
   * A single CHILD_OF link is replaced; `parentSlug: null` lifts the row to the
   * root. Lives with the link routes because that is all a move is.
   */
  app.put('/api/projects/:id/requirements/:rid/parent', async (req) => {
    const { id, rid } = parseInput(moveParams, req.params);
    const body = parseInput(moveBody, req.body);
    const service = await serviceFor(id);
    return service.move({
      childSlug: rid,
      newParentSlug: body.parentSlug,
      expectedParentSlug: body.expectedParentSlug,
    });
  });
}
