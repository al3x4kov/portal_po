import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createProjectService, type ServiceContext } from '../factory.js';
import { parseInput } from '../lib/parseInput.js';
import type { AppDeps } from './deps.js';

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
});

const idParam = z.object({ id: z.string().min(1) });

/** Project routes: GET /api/projects, POST /api/projects, GET /api/projects/:id (T-304). */
export async function projectRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const service = createProjectService(ctx);

  app.get('/api/projects', async () => {
    return service.list();
  });

  app.post('/api/projects', async (req, reply) => {
    const { name } = parseInput(createBody, req.body);
    const project = await service.create(name);
    reply.code(201);
    return project;
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = parseInput(idParam, req.params);
    return service.get(id);
  });
}
