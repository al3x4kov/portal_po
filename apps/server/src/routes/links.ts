import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LINK_TYPES } from '@po/core';
import { LinkService } from '../services/LinkService.js';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { FsProjectRepo } from '../repositories/FsProjectRepo.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

const linkBody = z.object({
  sourceId: z.string().min(1),
  type: z.enum(LINK_TYPES),
  targetId: z.string().min(1),
});

/** Link create/delete routes (T-404): POST/DELETE /api/projects/:id/links. */
export async function linkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const projectRepo = new FsProjectRepo(deps.projectsRoot);

  const serviceFor = async (projectId: string): Promise<LinkService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return new LinkService(new FsRequirementRepo(deps.projectsRoot, projectId), deps.now);
  };

  app.post('/api/projects/:id/links', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseInput(linkBody, req.body);
    const service = await serviceFor(id);
    await service.create(body);
    reply.code(201);
    return { ok: true };
  });

  app.delete('/api/projects/:id/links', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseInput(linkBody, req.body);
    const service = await serviceFor(id);
    await service.remove(body);
    return { ok: true };
  });
}
