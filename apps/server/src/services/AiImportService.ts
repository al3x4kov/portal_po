import { promises as fs } from 'node:fs';
import {
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_STRUCTURE_BATCH,
  resolveModelPreset,
  type AiImportJobView,
  type AiImportResult,
  type AiImportStartResponse,
  type AiModelPreset,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import type { LinkServicePort, RequirementServicePort } from './ports.js';
import type { AiClientFactory } from './AiHubService.js';
import type { AiImportJobs, AiImportJobState } from './AiImportJobs.js';
import type { OpLogger } from '../lib/logger.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { stripReasoning } from './aiReasoning.js';
import {
  AI_IMPORT_HINT_ARCHIVE,
  AI_IMPORT_HINT_CONFIGURE,
  AI_IMPORT_HINT_INTERNAL,
  AI_IMPORT_JSON_ATTEMPTS,
} from './aiImport/constants.js';
import { sanitize } from './aiImport/text.js';
import type { AiImportRuntime, ChatArgs, JsonCallOutcome } from './aiImport/types.js';
import { runUnpackStage } from './aiImport/unpackStage.js';
import { runAnalyzeStage } from './aiImport/analyzeStage.js';
import { runStructureStage } from './aiImport/structureStage.js';
import { runAggregateStage } from './aiImport/aggregateStage.js';
import { runPopulateStage } from './aiImport/populateStage.js';
import { runRelateStage } from './aiImport/relateStage.js';

// Re-exported so the public surface (routes, tests) is unchanged after the
// BE-1/BE-3 decomposition: the pure domain helpers now live in @po/core, and
// the constants / diagnostics live in ./aiImport/*.
export { breakParentCycles, nextQuarterOf } from '@po/core';
export {
  AI_IMPORT_HINT_ARCHIVE,
  AI_IMPORT_HINT_NO_DOCS,
  AI_IMPORT_HINT_CONFIGURE,
  AI_IMPORT_HINT_UPSTREAM,
  AI_IMPORT_HINT_UNPARSEABLE,
  AI_IMPORT_HINT_POPULATE,
  AI_IMPORT_HINT_INTERNAL,
  AI_IMPORT_DEFAULT_CRITICALITY,
  AI_IMPORT_JSON_ATTEMPTS,
} from './aiImport/constants.js';
export { noDocsMessage } from './aiImport/text.js';

export interface AiImportServiceDeps {
  now: () => string;
  jobs: AiImportJobs;
  configRepo: AiConfigRepo;
  makeAiClient: AiClientFactory;
  makeRequirementService: (projectId: string) => RequirementServicePort;
  makeLinkService: (projectId: string) => LinkServicePort;
  projectExists: (projectId: string) => Promise<boolean>;
  log?: OpLogger;
  /** Chunk size override for tests; production uses the core constant. */
  chunkChars?: number;
  /** Structure batch size override for tests; production uses the core constant (50). */
  structureBatch?: number;
}

/**
 * Use-case service for «AI подгрузка ФТ/НФТ из документации» (Task 11/13).
 * The pipeline is a sequence of isolated stages (see `./aiImport/*`):
 * unpack → analyze → structure → aggregate → populate → (optional) relate.
 * Each stage owns its algorithm and receives an {@link AiImportRuntime} for the
 * cross-cutting concerns (logging, cancel checks, AI calls, job failure); this
 * class owns job lifecycle, preconditions and the AI-call retry loop, and wires
 * the stages together. Creation goes through the EXISTING
 * RequirementService/LinkService so every core rule applies.
 */
export class AiImportService {
  private readonly deps: AiImportServiceDeps;
  private readonly running = new Map<string, Promise<void>>();

  constructor(deps: AiImportServiceDeps) {
    this.deps = deps;
  }

  /**
   * Validate preconditions (spec: project 404 → key/model 400 → size 400 →
   * running job 409) and launch the asynchronous run. Returns immediately
   * with the job id; the route answers 202.
   */
  async start(
    projectId: string,
    archivePath: string,
    modelOverride?: string,
    inferLinks = false,
  ): Promise<AiImportStartResponse> {
    if (!(await this.deps.projectExists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }

    const cfg = await this.deps.configRepo.read();
    const model = modelOverride ?? cfg.modelByProject[projectId];
    if (!cfg.apiKey || !model) {
      throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    }
    const apiKey = cfg.apiKey; // narrowed const — usable inside catch closure
    // todo_18: effective per-model preset (generic ← default-by-id ← override).
    // Drives temperature / token clamp / input chunking / reasoning for the whole run.
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);

    const stat = await fs.stat(archivePath);
    if (stat.size > AI_IMPORT_MAX_ARCHIVE_BYTES) {
      throw new BadRequestError(`Архив превышает лимит 50 МБ. ${AI_IMPORT_HINT_ARCHIVE}`);
    }

    const job = this.deps.jobs.create(projectId); // ConflictError (409) when running

    const run = this.run(
      job,
      archivePath,
      model,
      apiKey,
      cfg.baseURL,
      preset,
      inferLinks,
      stat.size,
    )
      .catch((err: unknown) => {
        // Belt-and-braces: run() handles its own failures; this guards a bug in
        // run() itself. todo_16 Ф4: the raw error text goes to the LOG only
        // (sanitized — it may embed upstream details); the user-facing error is
        // a stable readable message with an actionable hint.
        const raw = err instanceof Error ? err.message : String(err);
        this.logLine(job, 'error', sanitize(`Внутренняя ошибка автоматизации: ${raw}`, apiKey));
        if (job.status === 'running') {
          job.error = {
            message: 'Внутренняя ошибка автоматизации.',
            hint: AI_IMPORT_HINT_INTERNAL,
          };
          this.deps.jobs.finish(job, 'failed');
        }
      })
      .finally(async () => {
        this.running.delete(job.jobId);
        // Await the cleanup so that once the run promise settles (and thus
        // waitForCompletion resolves) the uploaded archive is deterministically
        // gone — fire-and-forget here caused a rare test flake. Swallow errors:
        // a failed unlink must not change the job's outcome.
        await fs.rm(archivePath, { force: true }).catch(() => {});
      });
    this.running.set(job.jobId, run);

    return { jobId: job.jobId };
  }

  /** Client view of a job. 404 when unknown or expired. */
  getView(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    return this.deps.jobs.view(job);
  }

  /**
   * Request cancellation (idempotent; a no-op after completion). The runner
   * honours the flag at the next chunk boundary (spec §2, cancel semantics).
   */
  cancel(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    if (job.status === 'running' && !job.cancelRequested) {
      job.cancelRequested = true;
      this.logLine(job, 'info', 'Получен запрос на остановку автоматизации.');
    }
    return this.deps.jobs.view(job);
  }

  /** Await the background run of a job (test synchronization helper). */
  async waitForCompletion(jobId: string): Promise<void> {
    await (this.running.get(jobId) ?? Promise.resolve());
  }

  private logLine(job: AiImportJobState, level: 'info' | 'warn' | 'error', message: string): void {
    job.log.push({ ts: this.deps.now(), level, message });
  }

  private fail(job: AiImportJobState, message: string, hint: string): void {
    this.logLine(job, 'error', message);
    job.error = { message, hint };
    this.deps.jobs.finish(job, 'failed');
  }

  /** Honour a pending cancel request; returns true when the job was stopped. */
  private cancelIfRequested(job: AiImportJobState, counters: AiImportResult): boolean {
    if (!job.cancelRequested) return false;
    job.result = { ...counters };
    this.logLine(
      job,
      'warn',
      `Автоматизация остановлена пользователем. Создано к моменту остановки: ` +
        `ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}, связей ${counters.links}, ` +
        `связей НФТ→ФТ: ${counters.relatesLinks}.`,
    );
    this.deps.jobs.finish(job, 'cancelled');
    return true;
  }

  /**
   * One AI call with up to {@link AI_IMPORT_JSON_ATTEMPTS} attempts while the
   * answer cannot be parsed (Task 13 A3/B2). Every failed attempt is logged
   * via `attemptWarn`; a pending cancel is honoured BETWEEN attempts (the job
   * is then already finished as cancelled). Upstream/network errors are never
   * retried — the caller decides what they mean for the job.
   *
   * todo_18: import calls request the model's FULL generation budget
   * (`preset.maxOutputTokens`) as `max_tokens` — thinking models spend part of
   * that budget on `<think>…</think>` reasoning BEFORE the JSON answer, so a
   * small per-call cap truncated the reply («ответ обрезан по лимиту токенов»).
   * A `finish_reason === 'length'` answer still logs `truncatedWarn` (B2); when
   * `parseFinal` is given, it replaces `parse` on the LAST attempt (lenient
   * salvage instead of losing the whole batch, B7).
   */
  private async chatWithJsonRetries<T>(
    args: ChatArgs<T> & { job: AiImportJobState; counters: AiImportResult },
  ): Promise<JsonCallOutcome<T>> {
    for (let attempt = 1; attempt <= AI_IMPORT_JSON_ATTEMPTS; attempt++) {
      let content: string;
      try {
        const res = await args.client.chat.completions.create({
          model: args.model,
          messages: args.messages,
          temperature: args.preset.temperature,
          // todo_18: import calls use the model's FULL generation budget so
          // thinking models have room for `<think>…</think>` reasoning AND the
          // JSON answer (a per-call cap truncated the reply). The preset value
          // is the single knob users raise for thinking models.
          max_tokens: args.preset.maxOutputTokens,
          ...(args.preset.topP !== undefined ? { top_p: args.preset.topP } : {}),
        });
        content = res.choices?.[0]?.message?.content ?? '';
        // todo_18: cut <think>…</think> reasoning wrappers (any position) BEFORE
        // JSON extraction — otherwise brackets inside the reasoning defeat the
        // parser and «thinking» models silently yield 0 pairs. `none` = verbatim.
        if (args.preset.reasoning === 'strip') content = stripReasoning(content);
        if (res.choices?.[0]?.finish_reason === 'length') {
          this.logLine(args.job, 'warn', args.truncatedWarn(attempt));
        }
      } catch (err) {
        return { kind: 'upstream', error: err as Error };
      }
      const parse =
        attempt === AI_IMPORT_JSON_ATTEMPTS && args.parseFinal ? args.parseFinal : args.parse;
      const value = parse(content);
      if (value !== null) return { kind: 'ok', value };
      this.logLine(args.job, 'warn', args.attemptWarn(attempt));
      if (attempt < AI_IMPORT_JSON_ATTEMPTS && this.cancelIfRequested(args.job, args.counters)) {
        return { kind: 'cancelled' };
      }
    }
    return { kind: 'unparsed' };
  }

  /** Bind the cross-cutting runtime (logging / cancel / fail / AI call) to one job+counters. */
  private buildRuntime(job: AiImportJobState, counters: AiImportResult): AiImportRuntime {
    return {
      job,
      counters,
      log: (level, message) => this.logLine(job, level, message),
      cancelled: () => this.cancelIfRequested(job, counters),
      fail: (message, hint) => this.fail(job, message, hint),
      chat: (args) => this.chatWithJsonRetries({ job, counters, ...args }),
    };
  }

  /** Final «done» transition — records counters and finishes the job as succeeded. */
  private completeJob(job: AiImportJobState, counters: AiImportResult): void {
    job.stage = 'done';
    job.progress = 100;
    job.result = { ...counters };
    this.logLine(
      job,
      'info',
      `Готово: создано ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}; ` +
        `пропущено существующих ${counters.skippedExisting}; связей ${counters.links}, ` +
        `связей НФТ→ФТ: ${counters.relatesLinks}.`,
    );
    this.deps.jobs.finish(job, 'succeeded');
  }

  /**
   * The asynchronous pipeline: a sequential composition of the stages. Never
   * throws for expected failures — each stage fails/cancels the job and returns
   * a stop signal (`ok:false` / `true`). The temp docs dir is always cleaned up.
   */
  private async run(
    job: AiImportJobState,
    archivePath: string,
    model: string,
    apiKey: string,
    baseURL: string,
    preset: AiModelPreset,
    inferLinks = false,
    archiveBytes = 0,
  ): Promise<void> {
    const counters: AiImportResult = {
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 0,
    };
    const rt = this.buildRuntime(job, counters);
    let docsDir: string | undefined;
    try {
      const unpacked = await runUnpackStage(rt, { archivePath, archiveBytes });
      docsDir = unpacked.docsDir;
      if (!unpacked.ok) return;

      const analyzed = await runAnalyzeStage(rt, {
        docsDir: unpacked.docsDir,
        files: unpacked.files,
        archiveMap: unpacked.archiveMap,
        model,
        apiKey,
        baseURL,
        preset,
        chunkChars: this.deps.chunkChars ?? preset.chunkChars,
        makeAiClient: this.deps.makeAiClient,
      });
      if (!analyzed.ok) return;

      const structured = await runStructureStage(rt, {
        extracted: analyzed.extracted,
        archiveMap: unpacked.archiveMap,
        client: analyzed.client,
        model,
        apiKey,
        preset,
        structureBatch: this.deps.structureBatch ?? AI_IMPORT_STRUCTURE_BATCH,
      });
      if (!structured.ok) return;

      const requirementService = this.deps.makeRequirementService(job.projectId);
      const aggregated = await runAggregateStage(rt, {
        extracted: analyzed.extracted,
        structureParentByKey: structured.structureParentByKey,
        requirementService,
      });
      if (!aggregated.ok) return;

      const linkService = this.deps.makeLinkService(job.projectId);
      const populated = await runPopulateStage(rt, {
        aggregated: aggregated.aggregated,
        existing: aggregated.existing,
        requirementService,
        linkService,
      });
      if (!populated.ok) return;

      // Optional relate step (todo_16 B2): best-effort, never fails the import.
      if (inferLinks) {
        const stopped = await runRelateStage(rt, {
          client: analyzed.client,
          model,
          preset,
          apiKey,
          requirementService,
          linkService,
        });
        if (stopped) return;
      }

      this.completeJob(job, counters);
    } finally {
      if (docsDir) await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
