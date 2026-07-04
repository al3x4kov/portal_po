import { randomBytes } from 'node:crypto';
import type {
  AiImportJobView,
  AiImportLogEntry,
  AiImportResult,
  AiImportStage,
  AiImportStatus,
} from '@po/core';
import { ConflictError } from '../lib/errors.js';

/** Finished jobs are kept for this long so the client can read the outcome. */
export const AI_IMPORT_JOB_TTL_MS = 30 * 60 * 1000;

/** Mutable in-memory state of one AI-import job (superset of the view). */
export interface AiImportJobState {
  jobId: string;
  projectId: string;
  status: AiImportStatus;
  stage: AiImportStage;
  progress: number;
  log: AiImportLogEntry[];
  result?: AiImportResult;
  error?: { message: string; hint: string };
  /** Set by the cancel endpoint; the runner honours it at a chunk boundary. */
  cancelRequested: boolean;
  /** Epoch ms when the job left `running` (drives the TTL sweep). */
  finishedAtMs?: number;
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
    for (const job of this.jobs.values()) {
      if (job.projectId === projectId && job.status === 'running') {
        throw new ConflictError(`Project "${projectId}" already has a running AI import job.`);
      }
    }
    const job: AiImportJobState = {
      jobId: randomBytes(12).toString('hex'),
      projectId,
      status: 'running',
      stage: 'unpack',
      progress: 0,
      log: [],
      cancelRequested: false,
    };
    this.jobs.set(job.jobId, job);
    return job;
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
    };
  }
}
