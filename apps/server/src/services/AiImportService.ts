import { promises as fs } from 'node:fs';
import {
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_STRUCTURE_BATCH,
  aiImportErrorFromCode,
  nextQuarterOf,
  resolveModelPreset,
  type AiImportConfirmBody,
  type AiImportErrorCode,
  type AiImportJobList,
  type AiImportJobSummary,
  type AiImportJobView,
  type AiImportResult,
  type AiImportStartResponse,
  type AiImportStatus,
  type AiModelPreset,
  type ProjectDictionaries,
  type TargetQuarter,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import type { FsAiJobsRepo } from '../repositories/AiJobsRepo.js';
import type { LinkServicePort, RequirementServicePort } from './ports.js';
import type { AiClientFactory } from './AiHubService.js';
import type { AiImportJobs, AiImportJobState } from './AiImportJobs.js';
import type { OpLogger } from '../lib/logger.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import { stripReasoning } from './aiReasoning.js';
import { buildArchiveMap } from './aiImportPrompt.js';
import {
  AI_IMPORT_HINT_ARCHIVE,
  AI_IMPORT_HINT_CONFIGURE,
  AI_IMPORT_JSON_ATTEMPTS,
} from './aiImport/constants.js';
import { sanitize } from './aiImport/text.js';
import type { AiImportRuntime, ChatArgs, JsonCallOutcome } from './aiImport/types.js';
import { callAiWithRetries, type AiCallErrorClass } from './aiImport/aiCall.js';
import { BudgetTracker } from './aiImport/budget.js';
import { CheckpointRecorder, type AiJobCheckpoint } from './aiImport/checkpoint.js';
import { ReportBuilder } from './aiImport/report.js';
import { ResponseFormatNegotiator } from './aiImport/structuredOutput.js';
import { runUnpackStage } from './aiImport/unpackStage.js';
import { runInventoryStage, type InventoryFileEntry } from './aiImport/inventoryStage.js';
import { runEstimateStage } from './aiImport/estimateStage.js';
import { runAnalyzeStage, type AnalyzeResume } from './aiImport/analyzeStage.js';
import { runDedupeStage } from './aiImport/dedupe.js';
import { runStructureStage } from './aiImport/structureStage.js';
import { runAggregateStage } from './aiImport/aggregateStage.js';
import { runPopulateStage } from './aiImport/populateStage.js';
import { runRelateStage } from './aiImport/relateStage.js';
import { buildBacklogPreview, parseBacklogXlsx, type BacklogRow } from './aiImport/backlogXlsx.js';
import { runBacklogMatchStage } from './aiImport/backlogMatchStage.js';
import { runBacklogPopulateStage } from './aiImport/backlogPopulateStage.js';

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

/** Statuses a job can be resumed from (todo_20 T-212). */
const RESUMABLE_STATUSES: readonly AiImportStatus[] = ['failed', 'cancelled', 'interrupted'];

export interface AiImportServiceDeps {
  now: () => string;
  jobs: AiImportJobs;
  configRepo: AiConfigRepo;
  makeAiClient: AiClientFactory;
  makeRequirementService: (projectId: string) => RequirementServicePort;
  makeLinkService: (projectId: string) => LinkServicePort;
  projectExists: (projectId: string) => Promise<boolean>;
  log?: OpLogger;
  /**
   * todo_20 T-211: checkpoint repository (`Projects/<p>/.ai-jobs/`). When
   * absent (unit tests) the pipeline runs exactly as before — in-memory only,
   * no resume/history.
   */
  checkpoints?: FsAiJobsRepo;
  /** Chunk size override for tests; production uses the core constant. */
  chunkChars?: number;
  /** Structure batch size override for tests; production uses the core constant (50). */
  structureBatch?: number;
  /** todo_20 T-209: injectable backoff sleep (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** todo_20 T-209: injectable jitter source. */
  random?: () => number;
  /** todo_20 T-209: per-call timeout override for tests (ms); production uses the preset. */
  callTimeoutMs?: number;
  /** todo_20 T-213: millisecond clock for the ETA extrapolation (tests inject). */
  nowMs?: () => number;
  /**
   * todo_22: project dictionaries reader — the BACKLOG SourceEntry of every
   * created item carries the DEFAULT priority of the dictionary (PO №4).
   * Absent (old unit tests) ⇒ the seeded `default` priority id is used.
   */
  readDictionaries?: (projectId: string) => Promise<ProjectDictionaries>;
  /** todo_22: match-batch size override for tests; production uses 20. */
  backlogBatch?: number;
}

/** Shared target of a backlog run (confirm choice or the preview default). */
interface BacklogTarget {
  quarter: TargetQuarter;
  year: number;
}

/** Per-job context of a backlog run kept across the confirm/apply gates. */
interface BacklogRunCtx {
  recorder: CheckpointRecorder;
  rows: BacklogRow[];
  fileName: string;
  model: string;
}

/** Everything one run (fresh or resumed) needs besides the live job. */
interface RunContext {
  model: string;
  apiKey: string;
  baseURL: string;
  preset: AiModelPreset;
  inferLinks: boolean;
  recorder: CheckpointRecorder;
  fresh?: { archivePath: string; archiveBytes: number };
  resumed?: { checkpoint: AiJobCheckpoint };
}

/**
 * Use-case service for «AI подгрузка ФТ/НФТ из документации» (Task 11/13).
 * The pipeline is a sequence of isolated stages (see `./aiImport/*`):
 * unpack → inventory → estimate (+confirmation gate, T-204) → analyze →
 * dedupe → structure → aggregate → populate → (optional) relate.
 * Each stage owns its algorithm and receives an {@link AiImportRuntime} for the
 * cross-cutting concerns (logging, cancel checks, AI calls, job failure,
 * checkpointing); this class owns the job lifecycle (start / confirm / cancel /
 * resume / history) and the AI-call retry loop. Creation goes through the
 * EXISTING RequirementService/LinkService so every core rule applies.
 */
export class AiImportService {
  private readonly deps: AiImportServiceDeps;
  private readonly running = new Map<string, Promise<void>>();
  /** Deferred confirmations of jobs paused on the estimate gate (T-204). */
  private readonly confirmWaiters = new Map<string, (confirmed: boolean) => void>();
  /** todo_22: live context of backlog jobs (rebuilt from the checkpoint after a restart). */
  private readonly backlogRuns = new Map<string, BacklogRunCtx>();

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
      throw new BadRequestError(`Архив превышает лимит 200 МБ. ${AI_IMPORT_HINT_ARCHIVE}`);
    }

    const job = this.deps.jobs.create(projectId); // ConflictError (409) when running
    const recorder = new CheckpointRecorder(
      this.deps.checkpoints,
      {
        version: 1,
        jobId: job.jobId,
        projectId,
        model,
        inferLinks,
        startedAt: job.startedAt ?? this.deps.now(),
        status: 'running',
        stage: 'unpack',
        progress: 0,
        confirmed: false,
        log: [],
        counters: AiImportService.zeroCounters(),
      },
      this.deps.now,
    );

    const run = this.run(job, {
      model,
      apiKey,
      baseURL: cfg.baseURL,
      preset,
      inferLinks,
      recorder,
      fresh: { archivePath, archiveBytes: stat.size },
    })
      .catch((err: unknown) => this.handleInternalError(job, recorder, apiKey, err))
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

  /**
   * Resume a `failed`/`cancelled`/`interrupted` job from its checkpoint
   * (todo_20 T-212). 404 without a checkpoint; 409 for a non-resumable status
   * or when the checkpoint holds no analyzable data. Already-processed chunks
   * are NEVER re-sent to the model. The preset is re-resolved from the CURRENT
   * config, so a raised budget/threshold applies to the continuation.
   */
  async resume(jobId: string): Promise<AiImportStartResponse> {
    const repo = this.deps.checkpoints;
    const memJob = this.deps.jobs.get(jobId);
    const checkpoint = repo
      ? memJob
        ? await repo.load(memJob.projectId, jobId)
        : await repo.findByJobId(jobId)
      : undefined;
    if (!checkpoint) {
      throw new NotFoundError(`AI import job not found or has no checkpoint: "${jobId}".`);
    }
    const status = memJob?.status ?? checkpoint.status;
    if (!RESUMABLE_STATUSES.includes(status)) {
      throw new ConflictError(
        `AI import job "${jobId}" cannot be resumed from status "${status}".`,
      );
    }
    // todo_22: backlog jobs resume from their parsed rows / paid mappings.
    if (checkpoint.kind === 'backlog') return this.resumeBacklog(memJob, checkpoint);
    if (!checkpoint.analyze || !(await repo!.hasDocs(checkpoint.projectId, checkpoint.jobId))) {
      throw new ConflictError(
        `AI import job "${jobId}" has no resumable checkpoint data — start a new analysis.`,
      );
    }

    const cfg = await this.deps.configRepo.read();
    if (!cfg.apiKey) throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    const apiKey = cfg.apiKey;
    const model = checkpoint.model;
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);

    const job: AiImportJobState =
      memJob ??
      this.deps.jobs.adopt(AiImportService.jobFromCheckpoint(checkpoint, checkpoint.status));
    this.deps.jobs.reactivate(job); // 409 when the project has another active job
    const spent = (checkpoint.usage?.promptTokens ?? 0) + (checkpoint.usage?.completionTokens ?? 0);
    this.logLine(
      job,
      'info',
      `Продолжаю прогон с контрольной точки: обработано фрагментов ${checkpoint.analyze.processedChunks}, ` +
        `потрачено токенов ~${spent} — они повторно не оплачиваются.`,
    );

    const recorder = new CheckpointRecorder(
      repo,
      {
        ...structuredClone(checkpoint),
        status: 'running',
        error: undefined,
        finishedAt: undefined,
      },
      this.deps.now,
    );
    const run = this.run(job, {
      model,
      apiKey,
      baseURL: cfg.baseURL,
      preset,
      inferLinks: checkpoint.inferLinks,
      recorder,
      resumed: { checkpoint },
    })
      .catch((err: unknown) => this.handleInternalError(job, recorder, apiKey, err))
      .finally(() => this.running.delete(job.jobId));
    this.running.set(job.jobId, run);
    return { jobId: job.jobId };
  }

  /**
   * Confirm a job paused on a gate. Docs kind (todo_20 T-204): release the
   * estimate gate. Backlog kind (todo_22): accept the optional shared target
   * and launch the match stage. 404 unknown job, 409 wrong status. A paused
   * BACKLOG job that only lives on disk (server restarted) is re-adopted.
   */
  async confirm(jobId: string, target?: AiImportConfirmBody): Promise<AiImportJobView> {
    let job = this.deps.jobs.get(jobId);
    if (!job) {
      const cp = await this.deps.checkpoints?.findByJobId(jobId);
      if (cp?.kind === 'backlog' && cp.status === 'awaiting-confirmation') {
        job = this.deps.jobs.adopt(AiImportService.jobFromCheckpoint(cp, cp.status));
      } else if (cp) {
        throw new ConflictError(`AI import job "${jobId}" is not awaiting confirmation.`);
      } else {
        throw new NotFoundError(`AI import job not found: "${jobId}".`);
      }
    }
    if (job.status !== 'awaiting-confirmation') {
      throw new ConflictError(`AI import job "${jobId}" is not awaiting confirmation.`);
    }
    if (job.kind === 'backlog') return this.confirmBacklog(job, target);
    job.status = 'running';
    this.logLine(job, 'info', 'Смета подтверждена пользователем — продолжаю анализ.');
    const waiter = this.confirmWaiters.get(jobId);
    this.confirmWaiters.delete(jobId);
    waiter?.(true);
    return this.deps.jobs.view(job);
  }

  /** Client view of a job. 404 when unknown or expired. */
  getView(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    return this.deps.jobs.view(job);
  }

  /**
   * View of a job — from the in-memory registry when present, otherwise from
   * the on-disk checkpoint (history survives sweeps and restarts, PO №4).
   */
  async getViewOrHistory(jobId: string): Promise<AiImportJobView> {
    const job = this.deps.jobs.get(jobId);
    if (job) return this.deps.jobs.view(job);
    const cp = await this.deps.checkpoints?.findByJobId(jobId);
    if (!cp) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    return {
      jobId: cp.jobId,
      projectId: cp.projectId,
      status: cp.status,
      stage: cp.stage,
      progress: cp.progress,
      log: [...cp.log],
      ...(cp.result ? { result: cp.result } : {}),
      ...(cp.error ? { error: cp.error } : {}),
      ...(cp.relate ? { relate: cp.relate } : {}),
      ...(cp.usage ? { usage: cp.usage } : {}),
      ...(cp.inventory ? { inventory: cp.inventory } : {}),
      ...(cp.estimate ? { estimate: cp.estimate } : {}),
      ...(cp.report ? { report: cp.report } : {}),
      ...(cp.kind !== undefined ? { kind: cp.kind } : {}),
      ...(cp.backlog?.preview ? { backlogPreview: cp.backlog.preview } : {}),
      ...(cp.backlog?.review ? { backlogReview: cp.backlog.review } : {}),
      ...(cp.backlog?.report ? { backlogReport: cp.backlog.report } : {}),
    };
  }

  /** Full run history of a project (disk checkpoints ∪ in-memory jobs), newest first. */
  async listJobs(projectId: string): Promise<AiImportJobList> {
    if (!(await this.deps.projectExists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    const summaries = new Map<string, AiImportJobSummary>();
    if (this.deps.checkpoints) {
      for (const cp of await this.deps.checkpoints.list(projectId)) {
        summaries.set(cp.jobId, {
          jobId: cp.jobId,
          projectId,
          status: cp.status,
          startedAt: cp.startedAt,
          ...(cp.finishedAt ? { finishedAt: cp.finishedAt } : {}),
          ...(cp.result ? { result: cp.result } : {}),
          resumable: AiImportService.isResumable(cp.status, cp.error?.resumable),
          ...(cp.kind !== undefined ? { kind: cp.kind } : {}),
        });
      }
    }
    // In-memory entries win: they are fresher than their last checkpoint.
    for (const job of this.deps.jobs.byProject(projectId)) {
      summaries.set(job.jobId, {
        jobId: job.jobId,
        projectId,
        status: job.status,
        startedAt: job.startedAt ?? this.deps.now(),
        ...(job.finishedAtMs !== undefined
          ? { finishedAt: new Date(job.finishedAtMs).toISOString() }
          : {}),
        ...(job.result ? { result: { ...job.result } } : {}),
        resumable:
          this.deps.checkpoints !== undefined &&
          AiImportService.isResumable(job.status, job.error?.resumable),
        ...(job.kind !== undefined ? { kind: job.kind } : {}),
      });
    }
    const jobs = [...summaries.values()].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId),
    );
    return { jobs };
  }

  /** Full job log as plain text (`GET /api/ai-import/:jobId/log`, Н4). */
  async getLogText(jobId: string): Promise<string> {
    const job = this.deps.jobs.get(jobId);
    const log = job?.log ?? (await this.deps.checkpoints?.findByJobId(jobId))?.log;
    if (!log) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    return log.map((l) => `${l.ts} [${l.level.toUpperCase()}] ${l.message}`).join('\n') + '\n';
  }

  /**
   * Startup recovery (todo_20 T-211, Н3): every checkpoint left in an active
   * status by a killed process is marked `interrupted` on disk and registered
   * in memory, so the client sees it immediately with a working «Продолжить».
   */
  async recoverInterrupted(): Promise<void> {
    const repo = this.deps.checkpoints;
    if (!repo) return;
    for (const cp of await repo.markInterrupted(this.deps.now)) {
      const job = AiImportService.jobFromCheckpoint(cp, 'interrupted');
      job.finishedAtMs = Date.parse(cp.finishedAt ?? this.deps.now());
      this.deps.jobs.adopt(job);
      this.deps.log?.op({
        op: 'aiImport.interrupted',
        projectId: cp.projectId,
        outcome: 'ok',
      });
    }
    // todo_22: backlog jobs paused on a user gate survive a restart AS the
    // same pause (never `interrupted`) — re-adopt them so confirm/apply work.
    for (const cp of await repo.listPausedBacklog()) {
      if (this.deps.jobs.get(cp.jobId)) continue;
      try {
        this.deps.jobs.adopt(AiImportService.jobFromCheckpoint(cp, cp.status));
      } catch {
        // Another active job of the project won the conflict — the paused one
        // stays visible via history and can be re-adopted later.
      }
    }
  }

  /**
   * Request cancellation (idempotent; a no-op after completion). The runner
   * honours the flag at the next chunk boundary (spec §2, cancel semantics);
   * a job paused on the estimate gate is released and cancels immediately.
   */
  cancel(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    const active =
      job.status === 'running' ||
      job.status === 'awaiting-confirmation' ||
      job.status === 'awaiting-review';
    if (active && !job.cancelRequested) {
      job.cancelRequested = true;
      this.logLine(job, 'info', 'Получен запрос на остановку автоматизации.');
      const waiter = this.confirmWaiters.get(jobId);
      if (waiter) {
        this.confirmWaiters.delete(jobId);
        job.status = 'running'; // transitional: the runner finishes it as cancelled
        waiter(false);
      } else if (
        job.kind === 'backlog' &&
        (job.status === 'awaiting-confirmation' || job.status === 'awaiting-review') &&
        !this.running.has(jobId)
      ) {
        // todo_22: a PAUSED backlog job has no runner to honour the flag —
        // finish it here (nothing was written to the project before apply).
        this.logLine(job, 'warn', 'Импорт бэклога отменён — в проект ничего не записано.');
        this.deps.jobs.finish(job, 'cancelled');
        void this.ensureBacklogCtx(job)
          .then((ctx) => {
            ctx.recorder.save(job, ctx.recorder.state.counters);
            return ctx.recorder.flush();
          })
          .catch(() => {});
      }
    }
    return this.deps.jobs.view(job);
  }

  /** Await the background run of a job (test synchronization helper). */
  async waitForCompletion(jobId: string): Promise<void> {
    await (this.running.get(jobId) ?? Promise.resolve());
  }

  private static zeroCounters(): AiImportResult {
    return { createdFunctions: 0, createdNfrs: 0, skippedExisting: 0, links: 0, relatesLinks: 0 };
  }

  private static isResumable(status: AiImportStatus, errorResumable?: boolean): boolean {
    if (!RESUMABLE_STATUSES.includes(status)) return false;
    return errorResumable ?? true;
  }

  /** Rebuild an in-memory job from its checkpoint (restart / post-sweep resume). */
  private static jobFromCheckpoint(cp: AiJobCheckpoint, status: AiImportStatus): AiImportJobState {
    return {
      jobId: cp.jobId,
      projectId: cp.projectId,
      startedAt: cp.startedAt,
      status,
      stage: cp.stage,
      progress: cp.progress,
      log: [...cp.log],
      cancelRequested: false,
      // Partial «что уже создано» counters are always visible for history.
      result: cp.result ?? { ...cp.counters },
      ...(cp.error ? { error: cp.error } : {}),
      ...(cp.usage ? { usage: cp.usage } : {}),
      ...(cp.inventory ? { inventory: cp.inventory } : {}),
      ...(cp.estimate ? { estimate: cp.estimate } : {}),
      ...(cp.report ? { report: cp.report } : {}),
      ...(cp.relate ? { relate: cp.relate } : {}),
      // todo_22: backlog kind + payloads restored for the client view.
      ...(cp.kind !== undefined ? { kind: cp.kind } : {}),
      ...(cp.backlog?.preview ? { backlogPreview: structuredClone(cp.backlog.preview) } : {}),
      ...(cp.backlog?.review ? { backlogReview: structuredClone(cp.backlog.review) } : {}),
      ...(cp.backlog?.report ? { backlogReport: structuredClone(cp.backlog.report) } : {}),
    };
  }

  /** Belt-and-braces guard for a bug in run() itself (todo_16 Ф4 / T-213). */
  private handleInternalError(
    job: AiImportJobState,
    recorder: CheckpointRecorder,
    apiKey: string,
    err: unknown,
  ): void {
    const raw = err instanceof Error ? err.message : String(err);
    this.logLine(job, 'error', sanitize(`Внутренняя ошибка автоматизации: ${raw}`, apiKey));
    if (job.status === 'running' || job.status === 'awaiting-confirmation') {
      job.error = aiImportErrorFromCode('INT-01');
      this.deps.jobs.finish(job, 'failed');
      recorder.save(job, recorder.state.counters);
    }
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
    if (job.status !== 'running') return true; // already finished as cancelled
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
   * is then already finished as cancelled). Transient upstream errors are
   * retried INSIDE the wrapper (T-209); exhausted/fatal ones surface as an
   * `upstream` outcome the stage maps to registry codes.
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
    args: ChatArgs<T> & {
      job: AiImportJobState;
      counters: AiImportResult;
      budget?: BudgetTracker;
    },
  ): Promise<JsonCallOutcome<T>> {
    // todo_20 T-209: per-call timeout from the preset (test override wins).
    const timeoutMs = this.deps.callTimeoutMs ?? args.preset.perCallTimeoutSec * 1000;
    for (let attempt = 1; attempt <= AI_IMPORT_JSON_ATTEMPTS; attempt++) {
      let content = '';
      let transportDone = false;
      // Inner loop exists ONLY for the response_format downgrade: a backend
      // rejecting the parameter gets the SAME request repeated immediately in
      // the downgraded mode (T-206) — it never burns a JSON attempt.
      while (!transportDone) {
        const responseFormat = args.negotiator?.responseFormat();
        const result = await callAiWithRetries({
          call: (signal) =>
            args.client.chat.completions.create(
              {
                model: args.model,
                messages: args.messages,
                temperature: args.preset.temperature,
                // todo_18: import calls use the model's FULL generation budget so
                // thinking models have room for `<think>…</think>` reasoning AND
                // the JSON answer. The preset value is the single knob users
                // raise for thinking models.
                max_tokens: args.preset.maxOutputTokens,
                ...(args.preset.topP !== undefined ? { top_p: args.preset.topP } : {}),
                ...(responseFormat ? { response_format: responseFormat } : {}),
              },
              { signal, timeout: timeoutMs },
            ),
          timeoutMs,
          sleep: this.deps.sleep,
          random: this.deps.random,
          shouldStop: () => args.job.cancelRequested,
          // T-209/E3: every retry is visible in the log in Russian — «Timeout»
          // is never a bare word again (пилотный баг №3).
          onRetry: (diag) => {
            args.onUpstreamRetry?.(diag.errorClass);
            this.logLine(
              args.job,
              'warn',
              `Повтор запроса к модели: ${AiImportService.retryReason(diag.errorClass, timeoutMs)}; ` +
                `попытка ${diag.attempt} из ${diag.maxAttempts}, ожидание ${Math.max(1, Math.round(diag.waitMs / 1000))} с.`,
            );
          },
        });
        if (!result.ok) {
          if (result.errorClass === 'cancelled') {
            this.cancelIfRequested(args.job, args.counters);
            return { kind: 'cancelled' };
          }
          if (result.errorClass === 'bad-request' && args.negotiator?.noteRejected(result.error)) {
            this.logLine(
              args.job,
              'warn',
              'Бэкенд не поддерживает структурированный формат ответа — переключаюсь на совместимый режим.',
            );
            continue; // repeat immediately with the downgraded mode
          }
          if (result.errorClass === 'rate-limit') args.onUpstreamRetry?.('rate-limit');
          return { kind: 'upstream', error: result.error, errorClass: result.errorClass };
        }
        const res = result.value;
        // T-208/C4: usage is accumulated for EVERY answer (including ones that
        // later fail to parse) — that is what the tokens actually cost.
        if (args.budget) {
          args.budget.add(res.usage ?? undefined);
          args.job.usage = args.budget.view();
        }
        content = res.choices?.[0]?.message?.content ?? '';
        // todo_18: cut <think>…</think> reasoning wrappers (any position) BEFORE
        // JSON extraction — otherwise brackets inside the reasoning defeat the
        // parser and «thinking» models silently yield 0 pairs. `none` = verbatim.
        if (args.preset.reasoning === 'strip') content = stripReasoning(content);
        if (res.choices?.[0]?.finish_reason === 'length') {
          this.logLine(args.job, 'warn', args.truncatedWarn(attempt));
        }
        transportDone = true;
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

  /** Human (RU) reason of one transient retry class. */
  private static retryReason(errorClass: AiCallErrorClass, timeoutMs: number): string {
    switch (errorClass) {
      case 'rate-limit':
        return 'сервис ограничивает частоту запросов (429)';
      case 'server':
        return 'сервис AI ответил ошибкой сервера';
      case 'network':
        return 'сетевая ошибка при обращении к сервису AI';
      case 'timeout':
        return `ответ не получен за ${Math.round(timeoutMs / 1000)} с (тайм-аут вызова)`;
      default:
        return 'временная ошибка сервиса AI';
    }
  }

  /** Bind the cross-cutting runtime (logging / cancel / fail / AI call / checkpoint). */
  private buildRuntime(
    job: AiImportJobState,
    counters: AiImportResult,
    budget: BudgetTracker,
    recorder: CheckpointRecorder,
  ): AiImportRuntime {
    const checkpoint = (mutate?: (state: AiJobCheckpoint) => void): void => {
      mutate?.(recorder.state);
      recorder.save(job, counters);
    };
    return {
      job,
      counters,
      log: (level, message) => this.logLine(job, level, message),
      cancelled: () => {
        const stopped = this.cancelIfRequested(job, counters);
        if (stopped) checkpoint();
        return stopped;
      },
      fail: (message, hint) => {
        this.fail(job, message, hint);
        job.result = { ...counters };
        checkpoint();
      },
      failCode: (code: AiImportErrorCode, overrides?: { message?: string; hint?: string }) => {
        const error = aiImportErrorFromCode(code, overrides);
        this.logLine(job, 'error', `[${code}] ${error.message}`);
        job.error = error;
        // T-213: «что уже создано» is always visible on the fail screen.
        job.result = { ...counters };
        this.deps.jobs.finish(job, 'failed');
        checkpoint();
      },
      chat: (args) => this.chatWithJsonRetries({ job, counters, budget, ...args }),
      checkpoint,
    };
  }

  /** Final «done» transition — records counters and finishes the job as succeeded. */
  private completeJob(job: AiImportJobState, counters: AiImportResult): void {
    job.stage = 'done';
    job.progress = 100;
    job.result = { ...counters };
    job.etaSeconds = 0;
    this.logLine(
      job,
      'info',
      `Готово: создано ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}; ` +
        `пропущено существующих ${counters.skippedExisting}; связей ${counters.links}, ` +
        `связей НФТ→ФТ: ${counters.relatesLinks}.`,
    );
    this.deps.jobs.finish(job, 'succeeded');
  }

  /** Pause the run on the estimate gate until confirm()/cancel() releases it. */
  private awaitConfirmation(job: AiImportJobState): Promise<boolean> {
    job.status = 'awaiting-confirmation';
    this.logLine(
      job,
      'info',
      'Смета выше порога подтверждения — анализ приостановлен. Нажмите «Запустить всё равно», чтобы продолжить, или отмените прогон.',
    );
    return new Promise<boolean>((resolve) => this.confirmWaiters.set(job.jobId, resolve));
  }

  /*
   * ── todo_22 · T-304: backlog import (kind='backlog', same job machine) ────
   * parse → awaiting-confirmation (preview) → confirm {target} → match →
   * awaiting-review (mapping only, NO project writes) → apply {rowIds} →
   * populate → succeeded + report. The gates are REST calls, not in-process
   * waiters — a paused job survives a restart as the same pause.
   */

  /**
   * Start a backlog import: validate preconditions like {@link start} (project
   * 404 → key/model 400 → running job 409) and launch the deterministic parse
   * stage. The xlsx itself is deleted right after parsing — the parsed rows in
   * the checkpoint are the resumable payload.
   */
  async startBacklog(
    projectId: string,
    uploadPath: string,
    fileName: string,
    modelOverride?: string,
  ): Promise<AiImportStartResponse> {
    if (!(await this.deps.projectExists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }
    const cfg = await this.deps.configRepo.read();
    const model = modelOverride ?? cfg.modelByProject[projectId];
    if (!cfg.apiKey || !model) {
      throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    }
    const apiKey = cfg.apiKey;

    const job = this.deps.jobs.create(projectId); // ConflictError (409) when running
    job.kind = 'backlog';
    const recorder = new CheckpointRecorder(
      this.deps.checkpoints,
      {
        version: 1,
        kind: 'backlog',
        jobId: job.jobId,
        projectId,
        model,
        inferLinks: false,
        startedAt: job.startedAt ?? this.deps.now(),
        status: 'running',
        stage: 'unpack',
        progress: 0,
        confirmed: false,
        log: [],
        counters: AiImportService.zeroCounters(),
        backlog: { fileName, rows: [] },
      },
      this.deps.now,
    );
    this.backlogRuns.set(job.jobId, { recorder, rows: [], fileName, model });

    const run = this.runBacklogParse(job, recorder, uploadPath, fileName)
      .catch((err: unknown) => this.handleInternalError(job, recorder, apiKey, err))
      .finally(async () => {
        this.running.delete(job.jobId);
        await fs.rm(uploadPath, { force: true }).catch(() => {});
      });
    this.running.set(job.jobId, run);
    return { jobId: job.jobId };
  }

  /** Stage «parse» (deterministic, no AI): rows/columns/preview → the confirm gate. */
  private async runBacklogParse(
    job: AiImportJobState,
    recorder: CheckpointRecorder,
    uploadPath: string,
    fileName: string,
  ): Promise<void> {
    const counters = AiImportService.zeroCounters();
    const budget = BudgetTracker.fromJSON({ limit: null, promptTokens: 0, completionTokens: 0 });
    const rt = this.buildRuntime(job, counters, budget, recorder);
    try {
      this.logLine(job, 'info', `Читаю файл бэклога «${fileName}»…`);
      const buffer = await fs.readFile(uploadPath);
      const parsed = parseBacklogXlsx(buffer);
      if (!parsed.ok) {
        rt.failCode(parsed.code, parsed.message ? { message: parsed.message } : undefined);
        return;
      }
      const ctx = this.backlogRuns.get(job.jobId);
      if (ctx) ctx.rows = parsed.rows;
      job.progress = 5;
      job.backlogPreview = buildBacklogPreview(parsed, fileName, this.deps.now());
      const withTarget = parsed.rows.filter((r) => r.target !== undefined).length;
      this.logLine(
        job,
        'info',
        `Файл разобран: строк к обработке ${parsed.rows.length}, пропущено пустых ${parsed.skippedRows}` +
          (withTarget > 0 ? `, сроков из файла ${withTarget}` : '') +
          '. Проверьте предпросмотр и запустите анализ.',
      );
      job.status = 'awaiting-confirmation';
      rt.checkpoint((state) => {
        if (state.backlog) state.backlog.rows = structuredClone(parsed.rows);
      });
    } finally {
      await recorder.flush();
    }
  }

  /** Rebuild the run context from the checkpoint after a restart (or reuse). */
  private async ensureBacklogCtx(job: AiImportJobState): Promise<BacklogRunCtx> {
    const existing = this.backlogRuns.get(job.jobId);
    if (existing) return existing;
    const cp = await this.deps.checkpoints?.load(job.projectId, job.jobId);
    if (!cp?.backlog) {
      throw new ConflictError(
        `AI import job "${job.jobId}" has no backlog checkpoint — start a new import.`,
      );
    }
    const recorder = new CheckpointRecorder(
      this.deps.checkpoints,
      { ...structuredClone(cp), error: undefined, finishedAt: undefined },
      this.deps.now,
    );
    const ctx: BacklogRunCtx = {
      recorder,
      rows: cp.backlog.rows,
      fileName: cp.backlog.fileName,
      model: cp.model,
    };
    this.backlogRuns.set(job.jobId, ctx);
    return ctx;
  }

  /** Effective shared target: confirm body ← persisted choice ← preview default. */
  private backlogTargetOf(job: AiImportJobState, ctx: BacklogRunCtx): BacklogTarget {
    const persisted = ctx.recorder.state.backlog?.target;
    if (persisted) return persisted;
    const preview = job.backlogPreview?.defaultTarget;
    if (preview) return { quarter: preview.quarter, year: preview.year };
    const next = nextQuarterOf(this.deps.now());
    return { quarter: next.targetQuarter, year: next.targetYear };
  }

  /** Backlog confirm: accept the shared target and launch the match stage. */
  private async confirmBacklog(
    job: AiImportJobState,
    body?: AiImportConfirmBody,
  ): Promise<AiImportJobView> {
    const ctx = await this.ensureBacklogCtx(job);
    const cfg = await this.deps.configRepo.read();
    if (!cfg.apiKey) throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    const apiKey = cfg.apiKey;
    const preset = resolveModelPreset(ctx.model, cfg.modelPresets?.[ctx.model]);
    const target: BacklogTarget =
      body?.targetQuarter !== undefined && body.targetYear !== undefined
        ? { quarter: body.targetQuarter, year: body.targetYear }
        : this.backlogTargetOf(job, ctx);
    ctx.recorder.state.backlog!.target = target;

    job.status = 'running';
    job.stage = 'analyze';
    this.logLine(
      job,
      'info',
      `Запуск разметки: строк ${ctx.rows.length}; целевой квартал для строк без срока — ${target.quarter} ${target.year}.`,
    );
    const run = this.runBacklogMatch(job, ctx, {
      apiKey,
      baseURL: cfg.baseURL,
      preset,
      target,
    })
      .catch((err: unknown) => this.handleInternalError(job, ctx.recorder, apiKey, err))
      .finally(() => this.running.delete(job.jobId));
    this.running.set(job.jobId, run);
    return this.deps.jobs.view(job);
  }

  /** Stage «match» (batched AI): full mapping → the review gate. NO writes. */
  private async runBacklogMatch(
    job: AiImportJobState,
    ctx: BacklogRunCtx,
    opts: { apiKey: string; baseURL: string; preset: AiModelPreset; target: BacklogTarget },
  ): Promise<void> {
    const cp = ctx.recorder.state;
    const counters: AiImportResult = { ...cp.counters };
    const budget = BudgetTracker.fromJSON({
      limit: opts.preset.runBudgetTokens,
      promptTokens: cp.usage?.promptTokens ?? 0,
      completionTokens: cp.usage?.completionTokens ?? 0,
    });
    if (cp.usage) job.usage = budget.view();
    const rt = this.buildRuntime(job, counters, budget, ctx.recorder);
    try {
      const client = this.deps.makeAiClient(opts.apiKey, opts.baseURL);
      const existing = (await this.deps.makeRequirementService(job.projectId).list()).requirements;
      const outcome = await runBacklogMatchStage(rt, {
        rows: ctx.rows,
        target: opts.target,
        existing,
        client,
        model: ctx.model,
        apiKey: opts.apiKey,
        preset: opts.preset,
        negotiator: new ResponseFormatNegotiator(),
        batchSize: this.deps.backlogBatch,
        resume: cp.backlog?.match ? { mappings: cp.backlog.match.mappings } : undefined,
      });
      if (!outcome.ok) return;
      job.backlogReview = outcome.review;
      job.status = 'awaiting-review';
      job.progress = 80;
      this.logLine(
        job,
        'info',
        `Разметка готова: строк ${outcome.review.mappings.length}, новых узлов ${outcome.review.newNodes.length}, ` +
          `дублей ${outcome.review.duplicates}. До подтверждения в проект ничего не записано — проверьте и нажмите «Записать в проект».`,
      );
      rt.checkpoint();
    } finally {
      await ctx.recorder.flush();
    }
  }

  /**
   * Apply the reviewed selection: launch populate for the chosen rows.
   * 409 when the job is not on the review gate (a `failed` backlog job with a
   * saved review may re-apply — the populate is idempotent); 400 on unknown
   * rowIds. Nothing was written to the project before this call.
   */
  async apply(jobId: string, rowIds: string[]): Promise<AiImportJobView> {
    let job = this.deps.jobs.get(jobId);
    if (!job) {
      const cp = await this.deps.checkpoints?.findByJobId(jobId);
      if (cp?.kind === 'backlog' && cp.status === 'awaiting-review') {
        job = this.deps.jobs.adopt(AiImportService.jobFromCheckpoint(cp, cp.status));
      } else if (cp) {
        throw new ConflictError(`AI import job "${jobId}" is not awaiting review.`);
      } else {
        throw new NotFoundError(`AI import job not found: "${jobId}".`);
      }
    }
    if (job.kind !== 'backlog') {
      throw new ConflictError(`AI import job "${jobId}" is not a backlog import.`);
    }
    const review = job.backlogReview;
    const reApplicable = job.status === 'failed' && review !== undefined;
    if ((job.status !== 'awaiting-review' && !reApplicable) || !review) {
      throw new ConflictError(`AI import job "${jobId}" is not awaiting review.`);
    }
    const known = new Set(review.mappings.map((m) => m.rowId));
    const unknown = rowIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestError(`Неизвестные строки в выборе: ${unknown.slice(0, 5).join(', ')}.`);
    }
    const ctx = await this.ensureBacklogCtx(job);
    if (reApplicable) this.deps.jobs.reactivate(job);
    job.status = 'running';
    job.stage = 'populate';
    job.progress = 85;
    job.error = undefined;
    this.logLine(
      job,
      'info',
      `Запись в проект: выбрано строк ${rowIds.length} из ${review.mappings.length}.`,
    );
    const run = this.runBacklogApply(job, ctx, new Set(rowIds))
      .catch((err: unknown) =>
        this.handleInternalError(job, ctx.recorder, 'no-api-key-in-populate', err),
      )
      .finally(() => this.running.delete(job.jobId));
    this.running.set(job.jobId, run);
    return this.deps.jobs.view(job);
  }

  /** Stage «populate» for the selected rows (deterministic, idempotent). */
  private async runBacklogApply(
    job: AiImportJobState,
    ctx: BacklogRunCtx,
    selectedRowIds: ReadonlySet<string>,
  ): Promise<void> {
    const cp = ctx.recorder.state;
    const counters: AiImportResult = { ...cp.counters };
    const budget = BudgetTracker.fromJSON({
      limit: null,
      promptTokens: cp.usage?.promptTokens ?? 0,
      completionTokens: cp.usage?.completionTokens ?? 0,
    });
    const rt = this.buildRuntime(job, counters, budget, ctx.recorder);
    try {
      const dict = await this.deps.readDictionaries?.(job.projectId);
      const priorities = dict ? [...dict.priorities].sort((a, b) => a.order - b.order) : [];
      const outcome = await runBacklogPopulateStage(rt, {
        review: job.backlogReview!,
        selectedRowIds,
        fileName: ctx.fileName,
        requirementService: this.deps.makeRequirementService(job.projectId),
        linkService: this.deps.makeLinkService(job.projectId),
        defaultPriorityId: priorities[0]?.id ?? 'default',
        nodeTarget: this.backlogTargetOf(job, ctx),
        usage: job.usage ?? { promptTokens: 0, completionTokens: 0 },
      });
      if (!outcome.ok) return;
      const r = outcome.report;
      job.backlogReport = r;
      job.stage = 'done';
      job.progress = 100;
      job.result = { ...counters };
      this.logLine(
        job,
        'info',
        `Готово: создано ФТ ${r.created.functions}, НФТ ${r.created.nfrs}, новых узлов ${r.created.newNodes}, ` +
          `связей ${r.created.links}; пропущено дублей ${r.duplicatesSkipped}; не выбрано строк ${r.deselected}.`,
      );
      this.deps.jobs.finish(job, 'succeeded');
      rt.checkpoint();
    } finally {
      await ctx.recorder.flush();
    }
  }

  /** Resume a backlog job: match continues from paid batches; a saved review re-opens the gate. */
  private async resumeBacklog(
    memJob: AiImportJobState | undefined,
    checkpoint: AiJobCheckpoint,
  ): Promise<AiImportStartResponse> {
    if (!checkpoint.backlog || checkpoint.backlog.rows.length === 0) {
      throw new ConflictError(
        `AI import job "${checkpoint.jobId}" has no resumable checkpoint data — start a new analysis.`,
      );
    }
    const cfg = await this.deps.configRepo.read();
    if (!cfg.apiKey) throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    const apiKey = cfg.apiKey;
    const model = checkpoint.model;
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);

    const job: AiImportJobState =
      memJob ??
      this.deps.jobs.adopt(AiImportService.jobFromCheckpoint(checkpoint, checkpoint.status));
    this.deps.jobs.reactivate(job); // 409 when the project has another active job
    const recorder = new CheckpointRecorder(
      this.deps.checkpoints,
      {
        ...structuredClone(checkpoint),
        status: 'running',
        error: undefined,
        finishedAt: undefined,
      },
      this.deps.now,
    );
    const ctx: BacklogRunCtx = {
      recorder,
      rows: checkpoint.backlog.rows,
      fileName: checkpoint.backlog.fileName,
      model,
    };
    this.backlogRuns.set(job.jobId, ctx);

    if (checkpoint.backlog.review) {
      // The paid mapping is complete — back to the review gate, no AI calls.
      job.status = 'awaiting-review';
      job.stage = 'analyze';
      job.progress = 80;
      job.backlogReview = structuredClone(checkpoint.backlog.review);
      job.error = undefined;
      this.logLine(
        job,
        'info',
        'Разметка восстановлена из контрольной точки — проверьте её и запишите в проект.',
      );
      recorder.save(job, recorder.state.counters);
      await recorder.flush();
      return { jobId: job.jobId };
    }

    const matched = checkpoint.backlog.match?.mappings.length ?? 0;
    this.logLine(
      job,
      'info',
      `Продолжаю разметку бэклога с контрольной точки: размечено строк ${matched} — они повторно не оплачиваются.`,
    );
    const run = this.runBacklogMatch(job, ctx, {
      apiKey,
      baseURL: cfg.baseURL,
      preset,
      target: this.backlogTargetOf(job, ctx),
    })
      .catch((err: unknown) => this.handleInternalError(job, recorder, apiKey, err))
      .finally(() => this.running.delete(job.jobId));
    this.running.set(job.jobId, run);
    return { jobId: job.jobId };
  }

  /**
   * The asynchronous pipeline: a sequential composition of the stages. Never
   * throws for expected failures — each stage fails/cancels the job and returns
   * a stop signal (`ok:false` / `true`). Fresh runs unpack the archive (into
   * the job's checkpoint dir when checkpoints are enabled); resumed runs pick
   * up the persisted inventory/estimate/cursor and skip the paid work.
   */
  private async run(job: AiImportJobState, ctx: RunContext): Promise<void> {
    const cp = ctx.resumed?.checkpoint;
    const counters: AiImportResult = cp ? { ...cp.counters } : AiImportService.zeroCounters();
    // todo_20 T-208: one budget per run; a resumed run re-reads the limit from
    // the CURRENT preset (so «увеличьте бюджет и продолжите» works) while the
    // already-spent usage carries over.
    const budget = BudgetTracker.fromJSON({
      limit: ctx.preset.runBudgetTokens,
      promptTokens: cp?.usage?.promptTokens ?? 0,
      completionTokens: cp?.usage?.completionTokens ?? 0,
    });
    if (cp?.usage) job.usage = budget.view();
    const rt = this.buildRuntime(job, counters, budget, ctx.recorder);
    let docsDir: string | undefined;
    try {
      let files: InventoryFileEntry[];
      let archiveMap: ReturnType<typeof buildArchiveMap>;

      if (ctx.fresh) {
        // T-211: unpack into `.ai-jobs/<jobId>/docs` so the content survives a
        // restart; without a checkpoint repo the historical temp dir is used.
        const destDir = this.deps.checkpoints?.docsDir(job.projectId, job.jobId);
        const unpacked = await runUnpackStage(rt, { ...ctx.fresh, destDir });
        docsDir = unpacked.docsDir;
        if (!unpacked.ok) return;

        // todo_20 T-202: content triage BEFORE any extraction call. The stage
        // enum deliberately stays unchanged (the relate precedent): the outcome
        // is visible via job.inventory + the log.
        const inventoried = await runInventoryStage(rt, {
          docsDir: unpacked.docsDir,
          files: unpacked.files,
          totalEntries: unpacked.totalEntries,
          extensionCounts: unpacked.extensionCounts,
          model: ctx.model,
          apiKey: ctx.apiKey,
          baseURL: ctx.baseURL,
          preset: ctx.preset,
          makeAiClient: this.deps.makeAiClient,
        });
        if (!inventoried.ok) return;
        if (inventoried.files.length === 0) {
          rt.failCode('DATA-01', {
            message: 'Все файлы архива исключены из обработки (см. опись в логе).',
            hint: AI_IMPORT_HINT_ARCHIVE,
          });
          return;
        }
        files = inventoried.files;
        archiveMap = unpacked.archiveMap;
        // Seed the analyze cursor NOW: a checkpoint without it is not resumable.
        rt.checkpoint((state) => {
          state.analyze = {
            files,
            fileIndex: 0,
            charOffset: 0,
            processedChunks: 0,
            totalChunks: 0,
            extracted: [],
          };
        });
      } else {
        docsDir = this.deps.checkpoints!.docsDir(job.projectId, job.jobId);
        files = cp!.analyze!.files;
        archiveMap = buildArchiveMap(files.map((f) => f.path));
        job.inventory = cp!.inventory;
        job.stage = cp!.stage === 'unpack' ? 'analyze' : cp!.stage;
      }

      // todo_20 T-204: смета + гейт подтверждения (порог из пресета).
      const chunkChars = this.deps.chunkChars ?? ctx.preset.chunkChars;
      const estimated = await runEstimateStage(rt, {
        files,
        chunkChars,
        thresholdTokens: ctx.preset.estimateThresholdTokens,
      });
      const alreadyConfirmed = cp?.confirmed ?? false;
      if (estimated.estimate.overThreshold && !alreadyConfirmed) {
        const confirmation = this.awaitConfirmation(job); // sets the status first
        rt.checkpoint(); // the awaiting state must survive a restart
        const confirmed = await confirmation;
        if (!confirmed) {
          this.cancelIfRequested(job, counters);
          rt.checkpoint();
          return;
        }
      }
      rt.checkpoint((state) => {
        state.confirmed = true;
      });

      // T-213: incremental quality report — partial on failed/cancelled too.
      const report = cp?.report
        ? ReportBuilder.fromView(cp.report)
        : ReportBuilder.fromInventory(
            job.inventory ?? { totalFiles: 0, processed: {}, excluded: [] },
          );
      job.report = report.view();

      const resumeCursor: AnalyzeResume | undefined = cp
        ? {
            fileIndex: cp.analyze!.fileIndex,
            charOffset: cp.analyze!.charOffset,
            extracted: cp.analyze!.extracted,
            processedChunks: cp.analyze!.processedChunks,
            chunker: cp.chunker,
          }
        : undefined;
      const analyzed = await runAnalyzeStage(rt, {
        // Both branches above guarantee the docs dir once they fall through.
        docsDir: docsDir!,
        files: files.map((f) => f.path),
        archiveMap,
        model: ctx.model,
        apiKey: ctx.apiKey,
        baseURL: ctx.baseURL,
        preset: ctx.preset,
        chunkChars,
        makeAiClient: this.deps.makeAiClient,
        classes: new Map(files.map((f) => [f.path, f.sourceClass])),
        negotiator: new ResponseFormatNegotiator(),
        budget,
        report,
        resume: resumeCursor,
        nowMs: this.deps.nowMs,
      });
      if (!analyzed.ok) return;

      // T-207: deterministic dedupe + model-confirmed ambiguous pairs.
      const deduped = await runDedupeStage(rt, {
        extracted: analyzed.extracted,
        client: analyzed.client,
        model: ctx.model,
        preset: ctx.preset,
      });
      if (!deduped.ok) return;
      rt.checkpoint((state) => {
        if (state.analyze) state.analyze.extracted = [...deduped.extracted];
      });

      const structured = await runStructureStage(rt, {
        extracted: deduped.extracted,
        archiveMap,
        client: analyzed.client,
        model: ctx.model,
        apiKey: ctx.apiKey,
        preset: ctx.preset,
        structureBatch: this.deps.structureBatch ?? AI_IMPORT_STRUCTURE_BATCH,
      });
      if (!structured.ok) return;
      rt.checkpoint();

      const requirementService = this.deps.makeRequirementService(job.projectId);
      const aggregated = await runAggregateStage(rt, {
        extracted: deduped.extracted,
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
      rt.checkpoint();

      // Optional relate step (todo_16 B2): best-effort, never fails the import.
      if (ctx.inferLinks) {
        const stopped = await runRelateStage(rt, {
          client: analyzed.client,
          model: ctx.model,
          preset: ctx.preset,
          apiKey: ctx.apiKey,
          requirementService,
          linkService,
        });
        if (stopped) return;
      }

      this.completeJob(job, counters);
      rt.checkpoint();
    } finally {
      await ctx.recorder.flush();
      await this.cleanupDocs(job, docsDir);
    }
  }

  /**
   * Docs cleanup policy (T-211/T-212): a temp-dir run (no checkpoints) always
   * removes its docs; a checkpointed run keeps them while the job is resumable
   * and removes them once resuming can never happen (`succeeded` or a
   * non-resumable failure). `state.json` always stays — it IS the history.
   */
  private async cleanupDocs(job: AiImportJobState, docsDir: string | undefined): Promise<void> {
    if (!docsDir) return;
    if (!this.deps.checkpoints) {
      await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const gone =
      job.status === 'succeeded' || (job.status === 'failed' && job.error?.resumable === false);
    if (gone) await this.deps.checkpoints.removeDocs(job.projectId, job.jobId);
  }
}
