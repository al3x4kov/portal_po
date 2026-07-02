import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { CycleError, DomainError, HasChildrenError } from '@po/core';
import { httpStatusForCode } from './lib/errors.js';
import { registerOpenApi } from './openapi/plugin.js';
import { projectRoutes } from './routes/projects.js';
import { requirementRoutes } from './routes/requirements.js';
import { linkRoutes } from './routes/links.js';
import { archiveRoutes } from './routes/archive.js';

export interface BuildAppOptions {
  /** Root directory that holds all projects (Projects/). */
  projectsRoot: string;
  /** Clock for deterministic timestamps in tests. */
  now?: () => string;
  /** Pino logger options (or false to disable). */
  logger?: FastifyServerOptions['logger'];
  /** When set and existing, the built SPA in this directory is served. */
  staticRoot?: string;
}

/** Structured details surfaced for specific domain errors. */
function detailsFor(err: DomainError): unknown {
  if (err instanceof CycleError) return { path: err.path };
  if (err instanceof HasChildrenError) return { children: err.children };
  return undefined;
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
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      const status = httpStatusForCode(err.code);
      if (status >= 500) req.log.error({ err }, 'domain error mapped to 5xx');
      reply.status(status).send({ code: err.code, message: err.message, details: detailsFor(err) });
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
