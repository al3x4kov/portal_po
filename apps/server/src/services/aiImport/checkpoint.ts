import { z } from 'zod';
import {
  AI_IMPORT_SOURCE_CLASSES,
  AI_IMPORT_STAGES,
  AI_IMPORT_STATUSES,
  aiExtractedRequirementSchema,
  aiImportEstimateViewSchema,
  aiImportInventoryViewSchema,
  aiImportJobErrorSchema,
  aiImportLogEntrySchema,
  aiImportRelateViewSchema,
  aiImportReportViewSchema,
  aiImportResultSchema,
  aiImportUsageViewSchema,
  type AiImportResult,
} from '@po/core';
import type { AiImportJobState } from '../AiImportJobs.js';

/**
 * todo_20 · T-211: on-disk checkpoint of one AI-import job (spec П5, D1).
 *
 * The state lives in `Projects/<project>/.ai-jobs/<jobId>/state.json` (written
 * atomically after every chunk/stage) next to the unpacked `docs/` of the run,
 * so a `failed`/`cancelled` job — or one `interrupted` by a server restart —
 * resumes from the last chunk without re-paying the already-processed ones
 * (T-212). This schema is SERVER-INTERNAL persistence, not the REST contract:
 * the client only ever sees the job view / history built from it.
 */

/** Directory inside a project that holds job checkpoints (excluded from export). */
export const AI_JOBS_DIR = '.ai-jobs';
/** Checkpoint file name inside the job directory. */
export const AI_JOB_STATE_FILE = 'state.json';
/** Unpacked documentation of the run (kept while the job is resumable). */
export const AI_JOB_DOCS_DIR = 'docs';

/** Serialized {@link AdaptiveChunker} state (see adaptiveChunker.ts). */
const chunkerStateSchema = z.object({
  initialChars: z.number().int().min(1),
  minChars: z.number().int().min(1),
  currentChars: z.number().int().min(1),
  invalidJsonStreak: z.number().int().min(0),
  successStreak: z.number().int().min(0),
});

/** One inventoried file queued for extraction (mirrors InventoryFileEntry). */
const checkpointFileSchema = z.object({
  path: z.string().min(1),
  sourceClass: z.enum(AI_IMPORT_SOURCE_CLASSES),
  size: z.number().int().min(0),
});

/**
 * Analyze-stage cursor: `files[0..fileIndex)` are fully consumed;
 * `charOffset` chars of the NORMALIZED text of `files[fileIndex]` are already
 * committed (their extracted records are inside `extracted`). Resume slices
 * the normalized text at the offset and continues with the restored chunker.
 */
const analyzeCursorSchema = z.object({
  files: z.array(checkpointFileSchema),
  fileIndex: z.number().int().min(0),
  charOffset: z.number().int().min(0),
  processedChunks: z.number().int().min(0),
  totalChunks: z.number().int().min(0),
  extracted: z.array(aiExtractedRequirementSchema),
});
export type AnalyzeCursor = z.infer<typeof analyzeCursorSchema>;

export const aiJobCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  projectId: z.string().min(1),
  model: z.string().min(1),
  inferLinks: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(AI_IMPORT_STATUSES),
  stage: z.enum(AI_IMPORT_STAGES),
  progress: z.number().min(0).max(100),
  /** True once the estimate gate was passed (confirmed or not required). */
  confirmed: z.boolean(),
  log: z.array(aiImportLogEntrySchema),
  /** Live created-so-far counters (become `result` when the job finishes). */
  counters: aiImportResultSchema,
  result: aiImportResultSchema.optional(),
  error: aiImportJobErrorSchema.optional(),
  usage: aiImportUsageViewSchema.optional(),
  inventory: aiImportInventoryViewSchema.optional(),
  estimate: aiImportEstimateViewSchema.optional(),
  report: aiImportReportViewSchema.optional(),
  relate: aiImportRelateViewSchema.optional(),
  chunker: chunkerStateSchema.optional(),
  analyze: analyzeCursorSchema.optional(),
});
export type AiJobCheckpoint = z.infer<typeof aiJobCheckpointSchema>;

/** Persistence port of the recorder (implemented by FsAiJobsRepo). */
export interface CheckpointSink {
  save(state: AiJobCheckpoint): Promise<void>;
}

/**
 * Owns the mutable checkpoint state of ONE run and serializes its writes: each
 * {@link save} snapshots the live job into the state and enqueues an atomic
 * write behind the previous one (no interleaved/torn writes). With no sink
 * (tests constructing the service without a repo) it is a cheap no-op that
 * still keeps the in-memory state coherent.
 */
export class CheckpointRecorder {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: CheckpointSink | undefined,
    readonly state: AiJobCheckpoint,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Snapshot the live job/counters into the state and enqueue a write. */
  save(job: AiImportJobState, counters: AiImportResult): void {
    const s = this.state;
    s.status = job.status;
    s.stage = job.stage;
    s.progress = job.progress;
    s.log = [...job.log];
    s.counters = { ...counters };
    s.result = job.result ? { ...job.result } : undefined;
    s.error = job.error ? { ...job.error } : undefined;
    s.usage = job.usage ? { ...job.usage } : undefined;
    s.inventory = job.inventory ? structuredClone(job.inventory) : undefined;
    s.estimate = job.estimate ? { ...job.estimate } : undefined;
    s.report = job.report ? structuredClone(job.report) : undefined;
    s.relate = job.relate ? { ...job.relate } : undefined;
    if (job.status !== 'running' && job.status !== 'awaiting-confirmation') {
      s.finishedAt = s.finishedAt ?? this.now();
    }
    if (!this.sink) return;
    const snapshot = structuredClone(s);
    this.queue = this.queue.then(() => this.sink!.save(snapshot)).catch(() => {});
  }

  /** Await every enqueued write (end of run / tests). */
  async flush(): Promise<void> {
    await this.queue;
  }
}
