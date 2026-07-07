import type { AiExtractedRequirement, AiImportResult, AiModelPreset, Link } from '@po/core';
import type { AiClient } from '../AiHubService.js';
import type { AiImportJobState } from '../AiImportJobs.js';
import type { AiChatMessage } from '../aiPrompt.js';
import { buildArchiveMap } from '../aiImportPrompt.js';

/** Compact per-run archive map handed to every extraction/structure call. */
export type ArchiveMap = ReturnType<typeof buildArchiveMap>;

/** One aggregated record plus its resolved parent (by name, same type). */
export interface AggregatedRecord {
  record: AiExtractedRequirement;
  parentKey?: string;
  /** Effective parent name (from the structure stage) — for log messages. */
  parentName?: string;
}

/**
 * A record whose extracted CHILD_OF should be ensured after populate: either a
 * freshly created requirement, or a skipped EXISTING one (re-run after a crash
 * between requirement and link creation — PO decision: the missing link is
 * still created, existing links are never touched or duplicated).
 */
export interface LinkCandidate {
  item: AggregatedRecord;
  /** Snapshot links of an already-existing source; used to skip present links. */
  existingLinks?: Link[];
}

/** Outcome of one AI call with JSON retries (Task 13 A3/B2). */
export type JsonCallOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unparsed' }
  | { kind: 'cancelled' }
  | { kind: 'upstream'; error: Error };

/** Arguments to a single AI call with JSON retries (job/counters are bound by the runtime). */
export interface ChatArgs<T> {
  client: AiClient;
  model: string;
  preset: AiModelPreset;
  messages: AiChatMessage[];
  parse: (content: string) => T | null;
  /** Lenient parser for the last attempt (Task 14 B7); defaults to `parse`. */
  parseFinal?: (content: string) => T | null;
  attemptWarn: (attempt: number) => string;
  truncatedWarn: (attempt: number) => string;
}

/**
 * Runtime handed to every pipeline stage: the live job/counters plus the four
 * cross-cutting operations (log, cancel-check, fail, AI call). Stages own the
 * algorithm; the runtime owns job lifecycle and logging plumbing, so a stage
 * can be exercised in isolation with a fake runtime (no whole-pipeline run).
 */
export interface AiImportRuntime {
  readonly job: AiImportJobState;
  readonly counters: AiImportResult;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Honour a pending cancel; when true the job is already finished as cancelled. */
  cancelled(): boolean;
  fail(message: string, hint: string): void;
  chat<T>(args: ChatArgs<T>): Promise<JsonCallOutcome<T>>;
}
