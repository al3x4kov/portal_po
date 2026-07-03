import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aiConfigUpdateSchema,
  formatZodError,
  generateDescriptionRequestSchema,
  type AiConfigView,
  type AiModelsView,
  type GenerateDescriptionResponse,
} from '@po/core';
import { createAiConfigRepo, createAiHubService, type ServiceContext } from '../factory.js';
import { BadRequestError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/** Query schema for GET /api/ai/config. */
const configQuery = z.object({ projectId: z.string().min(1).optional() });

/** safeParse-then-throw-400 helper: an invalid body/query is a client error. */
function parse400<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) throw new BadRequestError(formatZodError(res.error));
  return res.data;
}

/**
 * AI Hub routes (Task 8): config read/write (key never returned), model listing
 * and description generation. The AI client is injected via `deps.makeAiClient`
 * so integration tests use a mock and production uses the `openai` wrapper.
 */
export async function aiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = {
    projectsRoot: deps.projectsRoot,
    now: deps.now,
    log: deps.log,
    makeAiClient: deps.makeAiClient,
  };
  const repo = createAiConfigRepo(ctx);
  const service = createAiHubService(ctx);

  app.get('/api/ai/config', async (req): Promise<AiConfigView> => {
    const { projectId } = parse400(configQuery, req.query);
    return repo.getView(projectId);
  });

  app.put('/api/ai/config', async (req): Promise<AiConfigView> => {
    const patch = parse400(aiConfigUpdateSchema, req.body);
    return repo.update(patch);
  });

  app.get('/api/ai/models', async (): Promise<AiModelsView> => {
    const models = await service.listModels();
    return { models };
  });

  app.post('/api/ai/generate-description', async (req): Promise<GenerateDescriptionResponse> => {
    const input = parse400(generateDescriptionRequestSchema, req.body);
    const description = await service.generateDescription(input);
    return { description };
  });
}
