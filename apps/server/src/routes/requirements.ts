import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  REQUIREMENT_FOLDER,
  REQUIREMENT_TYPES,
  requirementCreateSchema,
  requirementUpdateSchema,
  serialize,
  type Requirement,
} from '@po/core';
import { createProjectRepo, createRequirementService, type ServiceContext } from '../factory.js';
import type { RequirementService } from '../services/RequirementService.js';
import { parseInput } from '../lib/parseInput.js';
import { NotFoundError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/**
 * Request body for creating a requirement. Canonical contract shared verbatim
 * with the MCP `create_requirement` tool (ARCH-4) — re-exported here under the
 * route-local name that the OpenAPI generator consumes.
 */
export const createBody = requirementCreateSchema;

/** Request body for updating a requirement (type is immutable, ADR-001). */
export const updateBody = requirementUpdateSchema;

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

/** Path params (BE-6): zod-validated instead of unchecked `as {…}` casts. */
const idParams = z.object({ id: z.string().min(1) });
const slugParams = z.object({ id: z.string().min(1), slug: z.string().min(1) });

const FOLDER_LABEL = REQUIREMENT_FOLDER;

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
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const projectRepo = createProjectRepo(ctx);

  const serviceFor = async (projectId: string): Promise<RequirementService> => {
    if (!(await projectRepo.exists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    return createRequirementService(ctx, projectId);
  };

  app.get('/api/projects/:id/requirements', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
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
    const { id } = parseInput(idParams, req.params);
    const { type, name, excludeSlug } = parseInput(checkNameQuery, req.query);
    const service = await serviceFor(id);
    return service.checkName(type, name, excludeSlug);
  });

  app.post('/api/projects/:id/requirements', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(createBody, req.body);
    const service = await serviceFor(id);
    const created = await service.create(body);
    reply.code(201);
    return created;
  });

  app.put('/api/projects/:id/requirements/:slug', async (req) => {
    const { id, slug } = parseInput(slugParams, req.params);
    const body = parseInput(updateBody, req.body);
    const service = await serviceFor(id);
    return service.update(slug, body);
  });

  app.delete('/api/projects/:id/requirements/:slug', async (req, reply) => {
    const { id, slug } = parseInput(slugParams, req.params);
    const service = await serviceFor(id);
    await service.delete(slug);
    reply.code(204);
    return null;
  });
}
