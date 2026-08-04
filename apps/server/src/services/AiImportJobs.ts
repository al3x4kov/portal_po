import { randomBytes } from 'node:crypto';
import type {
  AiBacklogPreview,
  AiBacklogReport,
  AiBacklogReview,
  AiImportEstimateView,
  AiImportInventoryView,
  AiImportJobError,
  AiImportJobKind,
  AiImportJobView,
  AiImportLogEntry,
  AiImportRelateView,
  AiImportReportView,
  AiImportResult,
  AiImportSourceClass,
  AiImportStage,
  AiImportStatus,
  AiImportUsageView,
} from '@po/core';
import { ConflictError } from '../lib/errors.js';

/** Finished jobs are kept for this long so the client can read the outcome. */
export const AI_IMPORT_JOB_TTL_MS = 30 * 60 * 1000;

/**
 * Statuses of a job that still owns its project (blocks a second start).
 * todo_22: a backlog job paused on the review gate still owns the project —
 * its mapping must be applied or the job cancelled before the next import.
 */
export const AI_IMPORT_ACTIVE_STATUSES: readonly AiImportStatus[] = [
  'running',
  'awaiting-confirmation',
  'awaiting-review',
];

/** Mutable in-memory state of one AI-import job (superset of the view). */
export interface AiImportJobState {
  jobId: string;
  projectId: string;
  /** ISO timestamp of the run start (job history, todo_20 PO №4). */
  startedAt?: string;
  status: AiImportStatus;
  stage: AiImportStage;
  progress: number;
  log: AiImportLogEntry[];
  result?: AiImportResult;
  /** todo_20: extended error (registry code/category/action/resumable). */
  error?: AiImportJobError;
  /** Outcome of the optional relate step (todo_16 B2); set only when requested. */
  relate?: AiImportRelateView;
  /** Set by the cancel endpoint; the runner honours it at a chunk boundary. */
  cancelRequested: boolean;
  /** Epoch ms when the job left `running` (drives the TTL sweep). */
  finishedAtMs?: number;
  /* ── todo_20: progress-with-content + inventory/estimate/usage/report ── */
  currentFile?: string;
  currentClass?: AiImportSourceClass;
  chunkIndex?: number;
  chunkTotal?: number;
  etaSeconds?: number | null;
  /* ── todo_23 M3: живые «извлечено, ещё не записано» счётчики (analyze) ── */
  extractedFunctions?: number;
  extractedNfrs?: number;
  usage?: AiImportUsageView;
  inventory?: AiImportInventoryView;
  estimate?: AiImportEstimateView;
  report?: AiImportReportView;
  /* ── todo_22: backlog-kind fields (absent on docs jobs) ── */
  kind?: AiImportJobKind;
  backlogPreview?: AiBacklogPreview;
  backlogReview?: AiBacklogReview;
  backlogReport?: AiBacklogReport;
}

/**
 * In-memory job registry (PO decision §3.3: single local process, no queue).
 * One running job per project; finished jobs are swept after
 * {@link AI_IMPORT_JOB_TTL_MS}. `now` is injected for deterministic TTL tests.
 */
export class AiImportJobs {
  private readonly jobs = new Map<string, AiImportJobState>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private nowMs(): number {
    return Date.parse(this.now());
  }

  /** Drop finished jobs older than the TTL (lazy — no timers to leak). */
  private sweep(): void {
    const cutoff = this.nowMs() - AI_IMPORT_JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.finishedAtMs !== undefined && job.finishedAtMs < cutoff) this.jobs.delete(id);
    }
  }

  /**
   * Register a new running job. Throws {@link ConflictError} (409) when the
   * project already has a running job (PO decision §3.3).
   */
  create(projectId: string): AiImportJobState {
    this.sweep();
    this.assertNoActive(projectId);
    const job: AiImportJobState = {
      jobId: randomBytes(12).toString('hex'),
      projectId,
      startedAt: this.now(),
      status: 'running',
      stage: 'unpack',
      progress: 0,
      log: [],
      cancelRequested: false,
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  /** Throw {@link ConflictError} when the project already has an active job. */
  private assertNoActive(projectId: string, exceptJobId?: string): void {
    for (const job of this.jobs.values()) {
      if (
        job.projectId === projectId &&
        job.jobId !== exceptJobId &&
        AI_IMPORT_ACTIVE_STATUSES.includes(job.status)
      ) {
        throw new ConflictError(`Project "${projectId}" already has a running AI import job.`);
      }
    }
  }

  /**
   * Register a RESTORED job (startup interrupted-scan or a resume from disk,
   * todo_20 T-211/T-212). An active restored job conflicts like {@link create};
   * a finished one (e.g. `interrupted`) is adopted as-is for visibility.
   */
  adopt(job: AiImportJobState): AiImportJobState {
    this.sweep();
    if (AI_IMPORT_ACTIVE_STATUSES.includes(job.status)) {
      this.assertNoActive(job.projectId, job.jobId);
    }
    this.jobs.set(job.jobId, job);
    return job;
  }

  /** Jobs of one project currently held in memory (newest first). */
  byProject(projectId: string): AiImportJobState[] {
    this.sweep();
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }

  /**
   * Bring a finished job back to `running` for a resume (T-212). Conflicts when
   * another job of the project is active.
   */
  reactivate(job: AiImportJobState): void {
    this.assertNoActive(job.projectId, job.jobId);
    job.status = 'running';
    job.cancelRequested = false;
    job.error = undefined;
    delete job.finishedAtMs;
  }

  /** Look a job up (after a TTL sweep); undefined when unknown/expired. */
  get(jobId: string): AiImportJobState | undefined {
    this.sweep();
    return this.jobs.get(jobId);
  }

  /** Mark the job as done, stamping the TTL clock. */
  finish(job: AiImportJobState, status: Exclude<AiImportStatus, 'running'>): void {
    job.status = status;
    job.finishedAtMs = this.nowMs();
  }

  /** Immutable client projection of a job (the polled contract). */
  view(job: AiImportJobState): AiImportJobView {
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      log: [...job.log],
      ...(job.result ? { result: { ...job.result } } : {}),
      ...(job.error ? { error: { ...job.error } } : {}),
      ...(job.relate ? { relate: { ...job.relate } } : {}),
      // todo_20: progress-with-content + inventory/estimate/usage/report.
      ...(job.currentFile !== undefined ? { currentFile: job.currentFile } : {}),
      ...(job.currentClass !== undefined ? { currentClass: job.currentClass } : {}),
      ...(job.chunkIndex !== undefined ? { chunkIndex: job.chunkIndex } : {}),
      ...(job.chunkTotal !== undefined ? { chunkTotal: job.chunkTotal } : {}),
      ...(job.etaSeconds !== undefined ? { etaSeconds: job.etaSeconds } : {}),
      // todo_23 M3: живые extracted-счётчики (optional — старые view валидны).
      ...(job.extractedFunctions !== undefined
        ? { extractedFunctions: job.extractedFunctions }
        : {}),
      ...(job.extractedNfrs !== undefined ? { extractedNfrs: job.extractedNfrs } : {}),
      ...(job.usage ? { usage: { ...job.usage } } : {}),
      ...(job.inventory ? { inventory: structuredClone(job.inventory) } : {}),
      ...(job.estimate ? { estimate: { ...job.estimate } } : {}),
      ...(job.report ? { report: structuredClone(job.report) } : {}),
      // todo_22: backlog kind + payloads (absent on docs jobs — old views intact).
      ...(job.kind !== undefined ? { kind: job.kind } : {}),
      ...(job.backlogPreview ? { backlogPreview: structuredClone(job.backlogPreview) } : {}),
      ...(job.backlogReview ? { backlogReview: structuredClone(job.backlogReview) } : {}),
      ...(job.backlogReport ? { backlogReport: structuredClone(job.backlogReport) } : {}),
    };
  }
}
