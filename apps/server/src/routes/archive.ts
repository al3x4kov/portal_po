import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ExcelExportService } from '../services/ExcelExportService.js';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { createProjectRepo, createProjectService, type ServiceContext } from '../factory.js';
import { parseInput } from '../lib/parseInput.js';
import { contentDisposition } from '../lib/contentDisposition.js';
import { DomainError } from '@po/core';
import { ArchiveError, BadRequestError, NotFoundError } from '../lib/errors.js';
import type { ArchiveFormat } from '../repositories/types.js';
import type { AppDeps } from './deps.js';

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Query for archive export; also documented in OpenAPI (E14). */
export const exportQuery = z.object({
  format: z.enum(['zip', 'targz']).default('zip'),
});

/**
 * Slug pattern: only lowercase alphanumerics and hyphens are accepted.
 * This rule is enforced by the core slug-generation logic and prevents
 * path traversal (no dots, slashes, or backslashes). (T-523 / NFR-5)
 */
const SLUG_RE = /^[a-z0-9-]+$/;

/** Body schema for POST /api/projects/:id/export/selected (T-523). */
export const exportSelectedBody = z.object({
  format: z.enum(['zip', 'targz']),
  slugs: z
    .array(
      z
        .string()
        .min(1)
        .regex(SLUG_RE, 'Slug must contain only lowercase alphanumerics and hyphens'),
    )
    .min(1, 'At least one slug is required'),
});

/** Path params (BE-6): zod-validated instead of unchecked `as {…}` casts. */
const idParams = z.object({ id: z.string().min(1) });

/** Import/export routes (T-503): POST /api/projects/import, GET /api/projects/:id/export. */
export async function archiveRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = { projectsRoot: deps.projectsRoot, now: deps.now, log: deps.log };
  const service = createProjectService(ctx);
  const projectRepo = createProjectRepo(ctx);

  app.post('/api/projects/import', async (req, reply) => {
    let uploadPath: string | undefined;
    let name: string | undefined;

    // A malformed multipart upload (busboy parse error) surfaces here without a
    // 4xx status; translate it into a BAD_REQUEST domain error (QA-6) so it maps
    // to 400 in the unified format instead of leaking as a 500.
    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          uploadPath = path.join(os.tmpdir(), `po-import-${randomBytes(8).toString('hex')}`);
          await pipeline(part.file, createWriteStream(uploadPath));
        } else if (part.fieldname === 'name') {
          name = String(part.value);
        }
      }
    } catch (err) {
      if (uploadPath) await fs.rm(uploadPath, { force: true }).catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new BadRequestError(`Malformed multipart upload: ${(err as Error).message}`);
    }

    try {
      if (!uploadPath) throw new ArchiveError('No archive file provided in upload.');
      if (!name || name.trim().length === 0) throw new ArchiveError('Missing project name.');
      const project = await service.import(uploadPath, name);
      reply.code(201);
      return project;
    } finally {
      if (uploadPath) await fs.rm(uploadPath, { force: true }).catch(() => {});
    }
  });

  app.get('/api/projects/:id/export', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const { format } = parseInput(exportQuery, req.query);
    const result = await service.export(id, format as ArchiveFormat);

    reply.header('content-type', result.contentType);
    reply.header('content-disposition', contentDisposition(result.filename));
    return reply.send(result.body);
  });

  // T-523: partial export — only the listed slugs + manifest.
  app.post('/api/projects/:id/export/selected', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    // Body validation errors for this endpoint map to 400 (BAD_REQUEST): an
    // invalid slug pattern or an empty slugs array is a client-side data error.
    const bodyResult = exportSelectedBody.safeParse(req.body);
    if (!bodyResult.success) {
      throw new BadRequestError(bodyResult.error.issues.map((i) => i.message).join('; '));
    }
    const { format, slugs } = bodyResult.data;
    const result = await service.exportSelected(id, slugs, format as ArchiveFormat);

    reply.header('content-type', result.contentType);
    reply.header('content-disposition', contentDisposition(result.filename));
    return reply.send(result.body);
  });

  // Excel export (T-902): export-only workbook of requirements + links.
  app.get('/api/projects/:id/export.xlsx', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    if (!(await projectRepo.exists(id))) {
      throw new NotFoundError(`Project not found: "${id}".`);
    }
    const repo = new FsRequirementRepo(deps.projectsRoot, id);
    const { requirements } = await repo.loadAll();
    const buffer = await ExcelExportService.buildWorkbook(requirements);

    reply.header('content-type', XLSX_CONTENT_TYPE);
    reply.header('content-disposition', contentDisposition(`${id}.xlsx`));
    return reply.send(buffer);
  });
}
