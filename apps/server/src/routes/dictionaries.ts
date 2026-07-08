import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRIORITY_COLORS, SOURCE_TYPES } from '@po/core';
import { createDictionariesService, createProjectRepo, type ServiceContext } from '../factory.js';
import type { DictionariesService } from '../services/DictionariesService.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.string().min(1) });
const priorityParams = z.object({ id: z.string().min(1), pid: z.string().min(1) });
const sourceParams = z.object({ id: z.string().min(1), sid: z.string().min(1) });

/** Body for creating a priority. */
export const addPriorityBody = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.enum(PRIORITY_COLORS),
});

/** Body for updating a priority (all fields optional). */
export const updatePriorityBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.enum(PRIORITY_COLORS).optional(),
  order: z.number().int().min(0).optional(),
});

/** Query for deleting a priority (optional reassignment target). */
export const deletePriorityQuery = z.object({ reassignTo: z.string().min(1).optional() });

/** Body for creating a source. */
export const addSourceBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(SOURCE_TYPES),
  color: z.string().min(1).optional(),
});

/** Body for updating a source (all fields optional). */
export const updateSourceBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: z.enum(SOURCE_TYPES).optional(),
  color: z.string().min(1).optional(),
});

/** Per-project dictionaries CRUD routes (todo_19 T-112, §0.6). */
export async function dictionaryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const projectRepo = createProjectRepo(ctx);

  const serviceFor = async (projectId: string): Promise<DictionariesService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return createDictionariesService(ctx, projectId);
  };

  app.get('/api/projects/:id/dictionaries', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const service = await serviceFor(id);
    return service.get();
  });

  app.post('/api/projects/:id/dictionaries/priorities', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(addPriorityBody, req.body);
    const service = await serviceFor(id);
    const created = await service.addPriority(body);
    reply.code(201);
    return created;
  });

  app.put('/api/projects/:id/dictionaries/priorities/:pid', async (req) => {
    const { id, pid } = parseInput(priorityParams, req.params);
    const body = parseInput(updatePriorityBody, req.body);
    const service = await serviceFor(id);
    return service.updatePriority(pid, body);
  });

  app.delete('/api/projects/:id/dictionaries/priorities/:pid', async (req, reply) => {
    const { id, pid } = parseInput(priorityParams, req.params);
    const { reassignTo } = parseInput(deletePriorityQuery, req.query);
    const service = await serviceFor(id);
    await service.deletePriority(pid, reassignTo);
    reply.code(204);
    return null;
  });

  app.post('/api/projects/:id/dictionaries/sources', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(addSourceBody, req.body);
    const service = await serviceFor(id);
    const created = await service.addSource(body);
    reply.code(201);
    return created;
  });

  app.put('/api/projects/:id/dictionaries/sources/:sid', async (req) => {
    const { id, sid } = parseInput(sourceParams, req.params);
    const body = parseInput(updateSourceBody, req.body);
    const service = await serviceFor(id);
    return service.updateSource(sid, body);
  });

  app.delete('/api/projects/:id/dictionaries/sources/:sid', async (req, reply) => {
    const { id, sid } = parseInput(sourceParams, req.params);
    const service = await serviceFor(id);
    await service.deleteSource(sid);
    reply.code(204);
    return null;
  });
}
