import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { vi } from 'vitest';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { FsAiJobsRepo } from '../src/repositories/AiJobsRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService, type AiImportServiceDeps } from '../src/services/AiImportService.js';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  type ServiceContext,
} from '../src/factory.js';
import { fixedNow } from './helpers.js';

/**
 * todo_20 · волна 1.2 — shared fixtures of the AI-import tests: a scripted
 * client, a deterministic «слабая модель» (T-216: torn JSON, 429/500/timeouts,
 * truncation), a ≥200-file synthetic archive generator with the F2b variant
 * (same content, different layout/names/dialect) and a service harness wired
 * with the checkpoint repository.
 */

export const KIT_SECRET = 'sk-wave12-secret';
export const KIT_MODEL = 'Qwen-Coder-Next';
export const KIT_PROJECT = 'Demo';

export type Answer =
  | string
  | Error
  | (() => string | Error)
  | { content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export function httpError(
  status: number,
  message = `HTTP ${status}`,
  headers?: Record<string, string>,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

/** Scripted client: each call consumes the next answer (last one repeats). */
export function scriptedClient(answers: Answer[]): AiClient {
  let call = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] })) },
    chat: {
      completions: {
        create: vi.fn(async () => {
          const raw = answers[Math.min(call, answers.length - 1)]!;
          call += 1;
          const resolved = typeof raw === 'function' ? raw() : raw;
          if (resolved instanceof Error) throw resolved;
          if (typeof resolved === 'string') {
            return { choices: [{ message: { content: resolved } }] };
          }
          return {
            choices: [{ message: { content: resolved.content } }],
            usage: resolved.usage,
          };
        }),
      },
    },
  };
}

/** Write a zip with the given files into os.tmpdir(); caller removes it. */
export async function writeZipArchive(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  const file = path.join(os.tmpdir(), `po-wave12-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

export interface ImportHarness {
  ctx: ServiceContext;
  configRepo: AiConfigRepo;
  checkpoints: FsAiJobsRepo;
  jobs: AiImportJobs;
  makeService: (client: AiClient, overrides?: Partial<AiImportServiceDeps>) => AiImportService;
  setPreset: (override: Record<string, unknown>) => Promise<void>;
}

/**
 * Wire a service around a temp Projects root: project created, config stored,
 * checkpoint repo enabled (pass `checkpoints: undefined` in overrides to turn
 * checkpointing off for a specific test).
 */
export async function makeImportHarness(
  root: string,
  project: string = KIT_PROJECT,
): Promise<ImportHarness> {
  const ctx: ServiceContext = { projectsRoot: root, now: fixedNow };
  // Tolerate an existing project: a second harness over the same root models a
  // server restart (fresh job registry, same disk state).
  await createProjectService(ctx)
    .create(project)
    .catch(() => undefined);
  const configRepo = new AiConfigRepo(root);
  await configRepo.update({ apiKey: KIT_SECRET, projectId: project, model: KIT_MODEL });
  const checkpoints = new FsAiJobsRepo(root);
  const jobs = new AiImportJobs(fixedNow);
  const projectRepo = createProjectRepo(ctx);
  const makeService = (
    client: AiClient,
    overrides: Partial<AiImportServiceDeps> = {},
  ): AiImportService =>
    new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
      checkpoints,
      sleep: async () => {}, // instant backoff in tests
      random: () => 0,
      ...overrides,
    });
  const setPreset = async (override: Record<string, unknown>): Promise<void> => {
    await configRepo.update({ modelPresets: { [KIT_MODEL]: override } });
  };
  return { ctx, configRepo, checkpoints, jobs, makeService, setPreset };
}

/* ── T-216: синтетический архив + эталон ─────────────────────────────────── */

export interface SyntheticArchive {
  files: Record<string, string>;
  /** Canonical requirement names the weak model extracts (`Функция FN-i-j`). */
  etalon: string[];
}

/**
 * Deterministic synthetic documentation archive. Every file carries
 * `recordsPerFile` markers `FN-<file>-<n>`; the weak-model client extracts
 * exactly those, so the etalon is known in advance. `variant: 'F2b'` produces
 * the SAME content in a different layout: nested Cyrillic paths, another
 * wording and a `*`-list dialect instead of `-` bullets (приёмка №6b).
 */
export function syntheticArchive(opts: {
  files: number;
  recordsPerFile?: number;
  fillerLines?: number;
  variant?: 'F2' | 'F2b';
}): SyntheticArchive {
  const { files, recordsPerFile = 0, fillerLines = 0, variant = 'F2' } = opts;
  const out: Record<string, string> = {};
  const etalon: string[] = [];
  for (let i = 1; i <= files; i++) {
    const id = String(i).padStart(3, '0');
    const records: string[] = [];
    for (let j = 1; j <= recordsPerFile; j++) {
      const name = `FN-${id}-${j}`;
      etalon.push(`Функция ${name}`);
      records.push(
        variant === 'F2'
          ? `- Функция ${name} — краткое описание возможности ${j}.`
          : `* ${name} :: новая возможность номер ${j} (другая разметка)`,
      );
    }
    const filler = Array.from(
      { length: fillerLines },
      (_, k) => `Строка наполнения ${k + 1}: ${'текст '.repeat(8)}`,
    );
    const body =
      variant === 'F2'
        ? [`# Что нового в сборке ${id}`, ...records, ...filler].join('\n')
        : [`Что нового (выпуск ${id})`, ...records, ...filler].join('\n');
    const name = variant === 'F2' ? `notes/notes-${id}.md` : `заметки/выпуск-${id}/изменения.txt`;
    out[name] = body;
  }
  return { files: out, etalon };
}

/* ── T-216: детерминированная «слабая модель» ────────────────────────────── */

export interface WeakModelStats {
  calls: number;
  failures: number;
  extractionCalls: number;
}

export interface WeakModelOptions {
  /** Probability of an injected failure per call (default 0.05 — приёмка №2). */
  failureRate?: number;
  seed?: number;
  /** When true the 4th failure kind is a torn-JSON answer (default true). */
  tornJson?: boolean;
}

/** Deterministic LCG in [0..1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Deterministic weak-model client (T-216): a configurable share of calls fails
 * with a rotating kind — 429, 500, hang-until-abort (per-call timeout), torn
 * JSON. Successful extraction answers are derived from the PROMPT: every
 * `FN-\d+-\d+` marker of the chunk becomes one valid record, so the outcome is
 * exactly comparable with the synthetic etalon. Structure/dedupe requests get
 * a valid empty array (records stay roots — acceptable for these scenarios).
 */
export function makeWeakModelClient(opts: WeakModelOptions = {}): {
  client: AiClient;
  stats: WeakModelStats;
} {
  const failureRate = opts.failureRate ?? 0.05;
  const rand = lcg(opts.seed ?? 42);
  const stats: WeakModelStats = { calls: 0, failures: 0, extractionCalls: 0 };
  let failureKind = 0;

  const client: AiClient = {
    models: { list: async () => ({ data: [{ id: KIT_MODEL }] }) },
    chat: {
      completions: {
        create: vi.fn(
          (
            params: { messages: Array<{ role: string; content: string }> },
            options?: { signal?: AbortSignal },
          ) => {
            stats.calls += 1;
            if (rand() < failureRate) {
              stats.failures += 1;
              const kind = failureKind++ % (opts.tornJson === false ? 3 : 4);
              if (kind === 0) return Promise.reject(httpError(429, 'rate limited'));
              if (kind === 1) return Promise.reject(httpError(500, 'upstream exploded'));
              if (kind === 2) {
                // Hang until the per-call timeout aborts the request.
                return new Promise((_resolve, reject) => {
                  options?.signal?.addEventListener('abort', () =>
                    reject(new Error('aborted by client')),
                  );
                }) as never;
              }
              return Promise.resolve({
                choices: [
                  {
                    message: { content: '[{"type":"FUNCTION","name":"обрыв' },
                    finish_reason: 'length',
                  },
                ],
              }) as never;
            }
            const text = params.messages.map((m) => m.content).join('\n');
            let content = '[]';
            // The structure prompt is the only one carrying this literal schema.
            if (!text.includes('"parentName":string|null') && !text.includes('дедуплицируешь')) {
              stats.extractionCalls += 1;
              const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
              const ids = [...new Set((lastUser?.content ?? '').match(/FN-\d+-\d+/g) ?? [])];
              content = JSON.stringify(
                ids.map((id) => ({
                  type: 'FUNCTION',
                  name: `Функция ${id}`,
                  description: `Возможность ${id} из документации.`,
                  source: `docs § ${id}`,
                })),
              );
            }
            return Promise.resolve({
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }) as never;
          },
        ) as never,
      },
    },
  };
  return { client, stats };
}
