import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CRITICALITIES,
  REQUIREMENT_TYPES,
  TARGET_QUARTERS,
  serialize,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { RequirementService } from '../services/RequirementService.js';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { FsProjectRepo } from '../repositories/FsProjectRepo.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/** Request body for creating a requirement (also documented in OpenAPI, E14). */
export const createBody = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string(),
  criticality: z.enum(CRITICALITIES),
  description: z.string().optional(),
  implemented: z.boolean(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().optional(),
});

/** Request body for updating a requirement (type is immutable, ADR-001). */
export const updateBody = createBody.omit({ type: true });

/** Query for the name-availability check (E14 documented). */
export const checkNameQuery = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string(),
  excludeSlug: z.string().optional(),
});

/** Query for the requirements listing endpoint. */
export const listQuery = z.object({
  /** `openspec` returns concatenated OpenSpec markdown; otherwise the JSON list (T-1001). */
  format: z.enum(['json', 'openspec']).optional(),
});

const FOLDER_LABEL: Record<RequirementType, string> = { FUNCTION: 'functions', NFR: 'nfr' };

/**
 * Concatenate every requirement of a project into a single OpenSpec markdown
 * document for AI agents (T-1001): a top-level project heading followed by one
 * `## <folder>` section per requirement type, each holding the serialized
 * `### Requirement:` fragments (ADR-001).
 */
function toOpenSpecText(projectId: string, requirements: readonly Requirement[]): string {
  const parts: string[] = [`# OpenSpec: ${projectId}`];
  for (const type of REQUIREMENT_TYPES) {
    const reqs = requirements.filter((r) => r.type === type);
    if (reqs.length === 0) continue;
    parts.push('', `## ${FOLDER_LABEL[type]}`);
    for (const r of reqs) parts.push('', serialize(r).trimEnd());
  }
  return `${parts.join('\n')}\n`;
}

/** Requirement CRUD + name check routes (T-403). */
export async function requirementRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const projectRepo = new FsProjectRepo(deps.projectsRoot);

  const serviceFor = async (projectId: string): Promise<RequirementService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return new RequirementService(new FsRequirementRepo(deps.projectsRoot, projectId), deps.now);
  };

  app.get('/api/projects/:id/requirements', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format } = parseInput(listQuery, req.query);
    const service = await serviceFor(id);
    const result = await service.list();
    if (format === 'openspec') {
      reply.header('content-type', 'text/markdown; charset=utf-8');
      return toOpenSpecText(id, result.requirements);
    }
    return result;
  });

  app.get('/api/projects/:id/requirements/check-name', async (req) => {
    const { id } = req.params as { id: string };
    const { type, name, excludeSlug } = parseInput(checkNameQuery, req.query);
    const service = await serviceFor(id);
    return service.checkName(type, name, excludeSlug);
  });

  app.post('/api/projects/:id/requirements', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseInput(createBody, req.body);
    const service = await serviceFor(id);
    const created = await service.create(body);
    reply.code(201);
    return created;
  });

  app.put('/api/projects/:id/requirements/:slug', async (req) => {
    const { id, slug } = req.params as { id: string; slug: string };
    const body = parseInput(updateBody, req.body);
    const service = await serviceFor(id);
    return service.update(slug, body);
  });

  app.delete('/api/projects/:id/requirements/:slug', async (req, reply) => {
    const { id, slug } = req.params as { id: string; slug: string };
    const service = await serviceFor(id);
    await service.delete(slug);
    reply.code(204);
    return null;
  });
}
