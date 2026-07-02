import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { DomainError, type Requirement } from '@po/core';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  domainErrorDetails,
  linkInputShape,
  requirementCreateShape,
  requirementUpdateShape,
  NotFoundError,
  type ArchiveFormat,
  type LinkService,
  type OpLogger,
  type RequirementService,
  type ServiceContext,
} from '@po/server';

/**
 * Minimal shape of an MCP tool result — a subset of the SDK's `CallToolResult`
 * that we produce ourselves so the wrapper is fully testable without a live
 * stdio transport.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A registered MCP tool: name + input schema (raw Zod shape) + handler. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<ToolResult>;
}

/** Build an `ok` result carrying JSON text + structured content. */
function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Build an MCP error result from a domain error code + message, preserving the
 * structured `details` (ARCH-11): a cycle's `path`, a node's blocking `children`
 * etc. are carried in `structuredContent.error` instead of being collapsed into
 * the human-readable text line, so agents can act on them programmatically.
 */
function fail(code: string, message: string, details?: unknown): ToolResult {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return {
    content: [{ type: 'text', text: `[${code}] ${message}` }],
    structuredContent: { error },
    isError: true,
  };
}

/**
 * Wrap a typed tool body with input validation (Zod) + domain-error mapping.
 * Any {@link DomainError} (uniqueness, cycle, self-link, not-found, validation)
 * becomes a clean MCP error result instead of an uncaught exception.
 */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
): ToolDef {
  const schema = z.object(shape);
  return {
    name,
    description,
    inputSchema: shape,
    handler: async (args: unknown): Promise<ToolResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return fail('VALIDATION', parsed.error.issues.map((i) => i.message).join('; '));
      }
      try {
        return ok(await run(parsed.data));
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code, err.message, domainErrorDetails(err));
        throw err;
      }
    },
  };
}

/** Shared Zod field definitions for identifiers (project-local). */
const projectId = z.string().min(1);
const slug = z.string().min(1);

/** Serialize a Requirement to a plain record for structured tool output. */
function requirementRecord(req: Requirement): Record<string, unknown> {
  return { ...req } as unknown as Record<string, unknown>;
}

/**
 * Build the full set of MCP tools over a single `PROJECTS_ROOT`, reusing the
 * existing @po/server services/repositories directly (no HTTP). Read tools are
 * side-effect free; write tools return the resulting requirement state.
 */
export function createTools(projectsRoot: string, now?: () => string, log?: OpLogger): ToolDef[] {
  const clock = now ?? ((): string => new Date().toISOString());
  const ctx: ServiceContext = { projectsRoot, now: clock, log };
  const projectService = createProjectService(ctx);
  const projectRepo = createProjectRepo(ctx);

  const requireProject = async (id: string): Promise<void> => {
    if (!(await projectRepo.exists(id))) {
      throw new NotFoundError(`Project not found: "${id}".`);
    }
  };

  const reqService = (id: string): RequirementService => createRequirementService(ctx, id);
  const linkService = (id: string): LinkService => createLinkService(ctx, id);

  return [
    tool('list_projects', 'List all projects.', {}, async () => {
      const projects = await projectService.list();
      return { projects };
    }),

    tool('get_project', 'Get a single project by id.', { projectId }, async ({ projectId: id }) => {
      const project = await projectService.get(id);
      return { project };
    }),

    tool(
      'list_requirements',
      'List every requirement of a project (empty array when none).',
      { projectId },
      async ({ projectId: id }) => {
        await requireProject(id);
        const { requirements, broken, incomplete } = await reqService(id).list();
        return { requirements, broken, incomplete };
      },
    ),

    tool(
      'get_requirement',
      'Get one requirement of a project by slug.',
      { projectId, slug },
      async ({ projectId: id, slug: s }) => {
        await requireProject(id);
        const { requirements } = await reqService(id).list();
        const req = requirements.find((r) => r.slug === s);
        if (!req) throw new NotFoundError(`Requirement not found: "${s}".`);
        return { requirement: requirementRecord(req) };
      },
    ),

    tool(
      'create_requirement',
      'Create a requirement; returns the created requirement.',
      { projectId, ...requirementCreateShape },
      async ({ projectId: id, ...input }) => {
        await requireProject(id);
        const req = await reqService(id).create(input);
        return { requirement: requirementRecord(req) };
      },
    ),

    tool(
      'update_requirement',
      'Update a requirement (slug/type immutable); returns the updated requirement.',
      { projectId, slug, ...requirementUpdateShape },
      async ({ projectId: id, slug: s, ...input }) => {
        await requireProject(id);
        const req = await reqService(id).update(s, input);
        return { requirement: requirementRecord(req) };
      },
    ),

    tool(
      'link_requirements',
      'Create a typed link between two requirements; returns the source requirement.',
      { projectId, ...linkInputShape },
      async ({ projectId: id, sourceSlug, type, targetSlug }) => {
        await requireProject(id);
        const service = linkService(id);
        await service.create({ sourceSlug, type, targetSlug });
        const { requirements } = await reqService(id).list();
        const source = requirements.find((r) => r.slug === sourceSlug);
        if (!source) throw new NotFoundError(`Requirement not found: "${sourceSlug}".`);
        return { requirement: requirementRecord(source) };
      },
    ),

    tool(
      'delete_requirement',
      'Delete a leaf requirement (rejected when it still has children).',
      { projectId, slug },
      async ({ projectId: id, slug: s }) => {
        await requireProject(id);
        await reqService(id).delete(s);
        return { deleted: true, slug: s };
      },
    ),

    tool(
      'export_project',
      'Export a project as an archive written to a temp file; returns its path.',
      { projectId, format: z.enum(['zip', 'targz']).default('zip') },
      async ({ projectId: id, format }) => {
        // ProjectService.export performs the existence check (404) and logging.
        const result = await projectService.export(id, format as ArchiveFormat);
        const outPath = path.join(
          os.tmpdir(),
          `po-mcp-export-${randomBytes(8).toString('hex')}-${result.filename}`,
        );
        // tar produces a minipass stream (not a node Readable instance), so
        // discriminate on Buffer — anything else is an async-iterable stream.
        const bytes = Buffer.isBuffer(result.body)
          ? await writeBuffer(result.body, outPath)
          : await writeStream(result.body, outPath);
        return { path: outPath, filename: result.filename, contentType: result.contentType, bytes };
      },
    ),
  ];
}

async function writeBuffer(buf: Buffer, dest: string): Promise<number> {
  await fs.writeFile(dest, buf);
  return buf.length;
}

async function writeStream(stream: Readable, dest: string): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const buf = Buffer.concat(chunks);
  await fs.writeFile(dest, buf);
  return buf.length;
}
