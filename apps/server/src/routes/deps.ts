import type { OpLogger } from '../lib/logger.js';

/** Dependencies injected into every route plugin. */
export interface AppDeps {
  projectsRoot: string;
  /** Clock injection point for deterministic timestamps in tests. */
  now: () => string;
  /** Structured operation logger (ARCH-7); wired from Fastify's pino in buildApp. */
  log?: OpLogger;
}
