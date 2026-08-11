import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../lib/atomicWrite.js';
import { resolveSafe } from '../lib/pathSafe.js';
import {
  AI_JOB_DOCS_DIR,
  AI_JOB_STATE_FILE,
  AI_JOBS_DIR,
  aiJobCheckpointSchema,
  type AiJobCheckpoint,
  type CheckpointSink,
} from '../services/aiImport/checkpoint.js';

/**
 * todo_20 · T-211: the ONLY place that touches `Projects/<project>/.ai-jobs/`.
 *
 * Layout per job: `.ai-jobs/<jobId>/state.json` (atomic writes, NFR-4) and
 * `.ai-jobs/<jobId>/docs/` — the unpacked documentation kept while the job is
 * resumable. Every path is resolved through {@link resolveSafe} (NFR-5), so a
 * hostile projectId/jobId can never escape the Projects root. The directory is
 * excluded from project export and ignored on import (see ArchiveRepo).
 */
export class FsAiJobsRepo implements CheckpointSink {
  constructor(private readonly projectsRoot: string) {}

  /**
   * Absolute job directory. Nested {@link resolveSafe}: the jobId must stay
   * inside the project's `.ai-jobs/` (a traversal jobId that would still land
   * inside Projects/ — e.g. another project's dir — is rejected too, NFR-5).
   */
  jobDir(projectId: string, jobId: string): string {
    const jobsRoot = resolveSafe(this.projectsRoot, projectId, AI_JOBS_DIR);
    return resolveSafe(jobsRoot, jobId);
  }

  /** Absolute directory of the unpacked docs of one job. */
  docsDir(projectId: string, jobId: string): string {
    return path.join(this.jobDir(projectId, jobId), AI_JOB_DOCS_DIR);
  }

  /** Atomically persist one checkpoint state. */
  async save(state: AiJobCheckpoint): Promise<void> {
    const file = path.join(this.jobDir(state.projectId, state.jobId), AI_JOB_STATE_FILE);
    await atomicWrite(file, JSON.stringify(state, null, 2));
  }

  /** Load one checkpoint; undefined when absent or unreadable/invalid. */
  async load(projectId: string, jobId: string): Promise<AiJobCheckpoint | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(this.jobDir(projectId, jobId), AI_JOB_STATE_FILE),
        'utf8',
      );
      const parsed = aiJobCheckpointSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** All checkpoints of one project, newest first (run history, PO №4). */
  async list(projectId: string): Promise<AiJobCheckpoint[]> {
    const dir = resolveSafe(this.projectsRoot, projectId, AI_JOBS_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const states: AiJobCheckpoint[] = [];
    for (const jobId of entries) {
      const state = await this.load(projectId, jobId);
      if (state) states.push(state);
    }
    states.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId));
    return states;
  }

  /** Find a checkpoint by jobId across every project (log/resume after sweep). */
  async findByJobId(jobId: string): Promise<AiJobCheckpoint | undefined> {
    for (const projectId of await this.projectIds()) {
      const state = await this.load(projectId, jobId);
      if (state) return state;
    }
    return undefined;
  }

  /** True when the unpacked docs of the job are still on disk (resume needs them). */
  async hasDocs(projectId: string, jobId: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.docsDir(projectId, jobId));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /** Remove the (potentially large) docs of a finished job; state.json stays. */
  async removeDocs(projectId: string, jobId: string): Promise<void> {
    await fs.rm(this.docsDir(projectId, jobId), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Startup scan (T-211, Н3): every job left `running`/`awaiting-confirmation`
   * on disk was killed mid-flight — mark it `interrupted` (with a Russian log
   * line and a finish timestamp) and return the updated states so the service
   * registers them as visible, resumable jobs.
   */
  async markInterrupted(now: () => string): Promise<AiJobCheckpoint[]> {
    const marked: AiJobCheckpoint[] = [];
    for (const projectId of await this.projectIds()) {
      for (const state of await this.list(projectId)) {
        if (state.status !== 'running' && state.status !== 'awaiting-confirmation') continue;
        // todo_22: a PAUSED backlog job (waiting for user confirmation) is not
        // «killed mid-flight» — after a restart it is the same pause, never
        // `interrupted` (see also listPausedGates()).
        if (state.kind === 'backlog' && state.status === 'awaiting-confirmation') continue;
        state.status = 'interrupted';
        state.finishedAt = now();
        state.log.push({
          ts: now(),
          level: 'warn',
          message:
            'Прогон прерван перезапуском сервера. Прогресс сохранён — нажмите «Продолжить», чтобы завершить анализ.',
        });
        await this.save(state);
        marked.push(state);
      }
    }
    return marked;
  }

  /**
   * todo_22: jobs paused on a REST user gate that must be re-adopted into
   * memory after a restart — the same pause survives, NOT `interrupted`.
   * Backlog jobs pause on `awaiting-confirmation` (preview) and
   * `awaiting-review` (mapping); docs jobs pause on `awaiting-review` only
   * (двухзонная выверка дублей) — their `awaiting-confirmation` (estimate) is
   * an in-process waiter and IS lost on restart (handled by markInterrupted).
   */
  async listPausedGates(): Promise<AiJobCheckpoint[]> {
    const paused: AiJobCheckpoint[] = [];
    for (const projectId of await this.projectIds()) {
      for (const state of await this.list(projectId)) {
        const pausedGate =
          state.kind === 'backlog'
            ? state.status === 'awaiting-confirmation' || state.status === 'awaiting-review'
            : state.status === 'awaiting-review';
        if (pausedGate) paused.push(state);
      }
    }
    return paused;
  }

  /** Project directories under the root (non-dot dirs only). */
  private async projectIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
