import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CRITICALITIES, REQUIREMENT_TYPES, TARGET_QUARTERS } from '@po/core';
import { RequirementService } from '../services/RequirementService.js';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { FsProjectRepo } from '../repositories/FsProjectRepo.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

const createBody = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string(),
  criticality: z.enum(CRITICALITIES),
  description: z.string().optional(),
  implemented: z.boolean(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().optional(),
});

const updateBody = createBody.omit({ type: true });

const checkNameQuery = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string(),
  excludeId: z.string().optional(),
});

/** Requirement CRUD + name check routes (T-403). */
export async function requirementRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const projectRepo = new FsProjectRepo(deps.projectsRoot);

  const serviceFor = async (projectId: string): Promise<RequirementService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return new RequirementService(new FsRequirementRepo(deps.projectsRoot, projectId), deps.now);
  };

  app.get('/api/projects/:id/requirements', async (req) => {
    const { id } = req.params as { id: string };
    const service = await serviceFor(id);
    return service.list();
  });

  app.get('/api/projects/:id/requirements/check-name', async (req) => {
    const { id } = req.params as { id: string };
    const { type, name, excludeId } = parseInput(checkNameQuery, req.query);
    const service = await serviceFor(id);
    return { available: await service.checkName(type, name, excludeId) };
  });

  app.post('/api/projects/:id/requirements', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseInput(createBody, req.body);
    const service = await serviceFor(id);
    const created = await service.create(body);
    reply.code(201);
    return created;
  });

  app.put('/api/projects/:id/requirements/:rid', async (req) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const body = parseInput(updateBody, req.body);
    const service = await serviceFor(id);
    return service.update(rid, body);
  });

  app.delete('/api/projects/:id/requirements/:rid', async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const service = await serviceFor(id);
    await service.delete(rid);
    reply.code(204);
    return null;
  });
}
