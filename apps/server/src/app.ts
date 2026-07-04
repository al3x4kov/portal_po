import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { DomainError } from '@po/core';
import { domainErrorDetails, httpStatusForCode } from './lib/errors.js';
import { pinoOpLogger } from './lib/logger.js';
import { registerOpenApi } from './openapi/plugin.js';
import { projectRoutes } from './routes/projects.js';
import { requirementRoutes } from './routes/requirements.js';
import { linkRoutes } from './routes/links.js';
import { archiveRoutes } from './routes/archive.js';
import { aiRoutes } from './routes/ai.js';
import { aiImportRoutes } from './routes/aiImport.js';
import type { AiClientFactory } from './services/AiHubService.js';

export interface BuildAppOptions {
  /** Root directory that holds all projects (Projects/). */
  projectsRoot: string;
  /** Clock for deterministic timestamps in tests. */
  now?: () => string;
  /** Pino logger options (or false to disable). */
  logger?: FastifyServerOptions['logger'];
  /** When set and existing, the built SPA in this directory is served. */
  staticRoot?: string;
  /**
   * AI client factory injection point (Task 8). Integration tests pass a mock;
   * when absent the production `openai`-backed factory is used.
   */
  makeAiClient?: AiClientFactory;
}

/**
 * Assemble the Fastify application (plugins, routes, unified error handler).
 * No network binding happens here — see main.ts for bootstrap (T-301).
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  const deps = {
    projectsRoot: opts.projectsRoot,
    now: opts.now ?? (() => new Date().toISOString()),
    log: pinoOpLogger(app.log),
    makeAiClient: opts.makeAiClient,
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      const status = httpStatusForCode(err.code);
      if (status >= 500) req.log.error({ err }, 'domain error mapped to 5xx');
      reply
        .status(status)
        .send({ code: err.code, message: err.message, details: domainErrorDetails(err) });
      return;
    }
    // Fastify/validation/multipart errors that carry an explicit status code.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const message = err instanceof Error ? err.message : 'Bad Request';
      reply.status(statusCode).send({ code: 'BAD_REQUEST', message, details: undefined });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply
      .status(500)
      .send({ code: 'INTERNAL', message: 'Internal Server Error', details: undefined });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // OpenAPI docs: GET /openapi.json (spec) + GET /docs (Swagger UI) — E14.
  await registerOpenApi(app);

  await app.register(projectRoutes, deps);
  await app.register(requirementRoutes, deps);
  await app.register(linkRoutes, deps);
  await app.register(archiveRoutes, deps);
  await app.register(aiRoutes, deps);
  await app.register(aiImportRoutes, deps);

  if (opts.staticRoot) {
    await app.register(fastifyStatic, { root: path.resolve(opts.staticRoot) });
    // SPA fallback for client-side routes (excluding the API).
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found', details: undefined });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
