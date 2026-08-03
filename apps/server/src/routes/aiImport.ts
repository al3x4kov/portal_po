import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aiImportInferLinksFieldSchema,
  DomainError,
  type AiImportJobList,
  type AiImportJobView,
} from '@po/core';
import { createAiImportService, type ServiceContext } from '../factory.js';
import { AiImportJobs } from '../services/AiImportJobs.js';
import { BadRequestError } from '../lib/errors.js';
import { parseInput } from '../lib/parseInput.js';
import { MAX_UPLOAD_BYTES } from '../lib/limits.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.string().min(1) });
const jobParams = z.object({ jobId: z.string().min(1) });

/**
 * AI-import routes (Task 11 / todo_20): start a documentation-import job
 * (multipart archive + optional `model` override), poll its status, confirm
 * the estimate, cancel, resume from a checkpoint, list the run history and
 * download the log. The job registry lives per app instance; the AI client is
 * injected via `deps.makeAiClient` (mock in tests, `openai` in production).
 */
export async function aiImportRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: ServiceContext = {
    projectsRoot: deps.projectsRoot,
    now: deps.now,
    log: deps.log,
    makeAiClient: deps.makeAiClient,
  };
  const jobs = new AiImportJobs(deps.now);
  const service = createAiImportService(ctx, jobs);
  // todo_20 T-211 (Н3): jobs killed by the previous process become visible,
  // resumable `interrupted` entries as soon as the server is up again.
  await service.recoverInterrupted();
  app.post('/api/projects/:id/ai-import', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);

    let uploadPath: string | undefined;
    let model: string | undefined;
    let inferLinksRaw: string | undefined;
    // Translate a busboy parse error into BAD_REQUEST (as routes/archive.ts).
    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          uploadPath = path.join(
            os.tmpdir(),
            `po-ai-import-upload-${randomBytes(8).toString('hex')}`,
          );
          await pipeline(part.file, createWriteStream(uploadPath));
          // ARCH-6: reject at the stream boundary. multipart truncates the file
          // at MAX_UPLOAD_BYTES; if it did, the archive is over the product limit
          // and nothing more should be written to tmp than the cap.
          if (part.file.truncated) {
            throw new BadRequestError(
              `Архив превышает лимит ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} МБ.`,
            );
          }
        } else if (part.fieldname === 'model') {
          const value = String(part.value).trim();
          if (value.length > 0) model = value;
        } else if (part.fieldname === 'inferLinks') {
          // todo_16 B2: optional boolean flag, same text-field style as `model`.
          const value = String(part.value).trim();
          if (value.length > 0) inferLinksRaw = value;
        }
      }
    } catch (err) {
      if (uploadPath) await fs.rm(uploadPath, { force: true }).catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new BadRequestError(`Malformed multipart upload: ${(err as Error).message}`);
    }

    if (!uploadPath) {
      throw new BadRequestError('No archive file provided in upload.');
    }
    try {
      let inferLinks = false;
      if (inferLinksRaw !== undefined) {
        const parsed = aiImportInferLinksFieldSchema.safeParse(inferLinksRaw);
        if (!parsed.success) {
          throw new BadRequestError('Поле inferLinks должно быть "true" или "false".');
        }
        inferLinks = parsed.data;
      }
      const started = await service.start(id, uploadPath, model, inferLinks);
      reply.code(202);
      return started;
    } catch (err) {
      // The job never started, so nobody else will clean the upload up.
      await fs.rm(uploadPath, { force: true }).catch(() => {});
      throw err;
    }
  });

  // todo_20 PO №4: full run history of a project (disk checkpoints ∪ memory).
  app.get('/api/projects/:id/ai-import/jobs', async (req): Promise<AiImportJobList> => {
    const { id } = parseInput(idParams, req.params);
    return service.listJobs(id);
  });

  app.get('/api/ai-import/:jobId', async (req): Promise<AiImportJobView> => {
    const { jobId } = parseInput(jobParams, req.params);
    return service.getViewOrHistory(jobId);
  });

  app.post('/api/ai-import/:jobId/cancel', async (req): Promise<AiImportJobView> => {
    const { jobId } = parseInput(jobParams, req.params);
    return service.cancel(jobId);
  });

  // todo_20 T-204: confirm the estimate of a job paused on the gate (409 otherwise).
  app.post('/api/ai-import/:jobId/confirm', async (req): Promise<AiImportJobView> => {
    const { jobId } = parseInput(jobParams, req.params);
    return service.confirm(jobId);
  });

  // todo_20 T-212: resume failed | cancelled | interrupted from the checkpoint.
  app.post('/api/ai-import/:jobId/resume', async (req, reply) => {
    const { jobId } = parseInput(jobParams, req.params);
    const started = await service.resume(jobId);
    reply.code(202);
    return started;
  });

  // todo_20 Н4: the full log as a downloadable text file.
  app.get('/api/ai-import/:jobId/log', async (req, reply) => {
    const { jobId } = parseInput(jobParams, req.params);
    const text = await service.getLogText(jobId);
    // The filename embeds the (validated-404 first) job id; strip anything
    // header-unsafe anyway — defense in depth against header injection.
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="ai-import-${safe}.log"`);
    return text;
  });
}
