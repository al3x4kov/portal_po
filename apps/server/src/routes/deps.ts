import type { OpLogger } from '../lib/logger.js';
import type { AiClientFactory } from '../services/AiHubService.js';

/** Dependencies injected into every route plugin. */
export interface AppDeps {
  projectsRoot: string;
  /** Clock injection point for deterministic timestamps in tests. */
  now: () => string;
  /** Structured operation logger (ARCH-7); wired from Fastify's pino in buildApp. */
  log?: OpLogger;
  /** AI client factory injection point (Task 8); mock in tests, `openai` in prod. */
  makeAiClient?: AiClientFactory;
}
