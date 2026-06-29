import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectService } from '../services/ProjectService.js';
import { parseInput } from '../lib/parseInput.js';
import { ArchiveError } from '../lib/errors.js';
import type { ArchiveFormat } from '../repositories/ArchiveRepo.js';
import type { AppDeps } from './deps.js';

const exportQuery = z.object({
  format: z.enum(['zip', 'targz']).default('zip'),
});

/** Import/export routes (T-503): POST /api/projects/import, GET /api/projects/:id/export. */
export async function archiveRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const service = new ProjectService(deps.projectsRoot, deps.now);

  app.post('/api/projects/import', async (req, reply) => {
    let uploadPath: string | undefined;
    let name: string | undefined;

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        uploadPath = path.join(os.tmpdir(), `po-import-${randomBytes(8).toString('hex')}`);
        await pipeline(part.file, createWriteStream(uploadPath));
      } else if (part.fieldname === 'name') {
        name = String(part.value);
      }
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
    const { id } = req.params as { id: string };
    const { format } = parseInput(exportQuery, req.query);
    const result = await service.export(id, format as ArchiveFormat);

    reply.header('content-type', result.contentType);
    reply.header('content-disposition', `attachment; filename="${result.filename}"`);
    return reply.send(result.body);
  });
}
