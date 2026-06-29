import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/main.js → apps/server/dist → apps/server → apps → <repo>
const repoRoot = path.resolve(here, '..', '..', '..');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const PROJECTS_ROOT = process.env.PROJECTS_ROOT
  ? path.resolve(process.env.PROJECTS_ROOT)
  : path.join(repoRoot, 'Projects');

async function main(): Promise<void> {
  const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
  const staticRoot = existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;

  const app = await buildApp({
    projectsRoot: PROJECTS_ROOT,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    staticRoot,
  });

  app.log.info({ projectsRoot: PROJECTS_ROOT, staticRoot: staticRoot ?? null }, 'starting server');
  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
