import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aiChatRequestSchema,
  aiConfigUpdateSchema,
  aiGenerateTestsRequestSchema,
  generateDescriptionRequestSchema,
  type AiChatResponse,
  type AiConfigView,
  type AiGenerateTestsResponse,
  type AiModelsView,
  type GenerateDescriptionResponse,
} from '@po/core';
import {
  createAiConfigRepo,
  createAiHubService,
  createRequirementService,
  type ServiceContext,
} from '../factory.js';
import { BadRequestError } from '../lib/errors.js';
import { parseInput } from '../lib/parseInput.js';
import type { AppDeps } from './deps.js';

/** Query schema for GET /api/ai/config. */
const configQuery = z.object({ projectId: z.string().min(1).optional() });

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
    const { projectId } = parseInput(configQuery, req.query);
    return repo.getView(projectId);
  });

  app.put('/api/ai/config', async (req): Promise<AiConfigView> => {
    const patch = parseInput(aiConfigUpdateSchema, req.body);
    return repo.update(patch);
  });

  app.get('/api/ai/models', async (): Promise<AiModelsView> => {
    const models = await service.listModels();
    return { models };
  });

  app.post('/api/ai/generate-description', async (req): Promise<GenerateDescriptionResponse> => {
    const input = parseInput(generateDescriptionRequestSchema, req.body);
    const description = await service.generateDescription(input);
    return { description };
  });

  app.post('/api/ai/chat', async (req): Promise<AiChatResponse> => {
    const input = parseInput(aiChatRequestSchema, req.body);
    // Переключатель «Учитывать требования проекта»: ФТ/НФТ грузятся из
    // проекта (источник истины) и уезжают в system-контекст под символьный
    // бюджет — и для 10–15, и для 1000–2000 требований (см. chatContext.ts).
    const projectRequirements =
      input.useProjectContext && input.projectId
        ? (await createRequirementService(ctx, input.projectId).list()).requirements
        : undefined;
    const content = await service.chat(input, projectRequirements);
    return { message: { role: 'assistant', content } };
  });

  // Развилка «Генерации артефактов»: AI-кейсы для одного батча требований.
  // Требования грузятся ИЗ ПРОЕКТА (источник истины) — неизвестный slug в
  // батче означает рассинхрон клиента и отвечает 400 до вызова модели.
  app.post('/api/ai/generate-tests', async (req): Promise<AiGenerateTestsResponse> => {
    const input = parseInput(aiGenerateTestsRequestSchema, req.body);
    const { requirements } = await createRequirementService(ctx, input.projectId).list();
    const bySlug = new Map(requirements.map((r) => [r.slug, r]));
    const unknown = input.slugs.filter((s) => !bySlug.has(s));
    if (unknown.length > 0) {
      throw new BadRequestError(
        `Требования не найдены в проекте: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.`,
      );
    }
    const batch = input.slugs.map((s) => bySlug.get(s)!);
    const nameBySlug = new Map(requirements.map((r) => [r.slug, r.name]));
    return service.generateTestCases(input, batch, nameBySlug);
  });
}
