import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { buildOpenApiDocument } from './document.js';

/**
 * Register OpenAPI documentation (E14):
 *   - `GET /openapi.json` — the OpenAPI 3.x JSON document.
 *   - `GET /docs`         — Swagger UI (assets served locally, no external CDN).
 *
 * `@fastify/swagger` runs in `static` mode with a document we build ourselves,
 * so route registration and behaviour (manual zod validation via `parseInput`,
 * unschema'd response serialization) are left completely untouched.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  const document = buildOpenApiDocument();

  await app.register(swagger, {
    mode: 'static',
    specification: { document },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    // Ship the bundled Swagger UI assets locally; never reach out to a CDN.
    uiConfig: { deepLinking: true },
    staticCSP: true,
  });

  // Stable, machine-readable spec URL the frontend links to.
  app.get('/openapi.json', async (_req, reply) => {
    reply.header('content-type', 'application/json; charset=utf-8');
    return document;
  });
}
