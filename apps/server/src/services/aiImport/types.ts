import type {
  AiExtractedRequirement,
  AiImportErrorCode,
  AiImportResult,
  AiModelPreset,
  Link,
} from '@po/core';
import type { AiClient } from '../AiHubService.js';
import type { AiImportJobState } from '../AiImportJobs.js';
import type { AiChatMessage } from '../aiPrompt.js';
import { buildArchiveMap } from '../aiImportPrompt.js';
import type { AiCallErrorClass } from './aiCall.js';
import type { AiJobCheckpoint } from './checkpoint.js';
import type { ResponseFormatNegotiator } from './structuredOutput.js';

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
  | { kind: 'ok'; value: T; truncated?: boolean }
  | { kind: 'unparsed' }
  | { kind: 'cancelled' }
  /**
   * todo_20 T-209: transient upstream errors are retried INSIDE the call
   * wrapper; this outcome means the retries are exhausted (or the error is
   * fatal). `errorClass` lets the stage map it to a registry code
   * (NET-01/02/03, CFG-02/03) or to a chunker signal (`context-length`).
   */
  | { kind: 'upstream'; error: Error; errorClass: AiCallErrorClass };

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
  /**
   * todo_20 T-206: per-run structured-output negotiation. When set, the call
   * sends `response_format` per the current mode and downgrades it once on a
   * backend rejection (the rejected request is repeated immediately and does
   * not burn a JSON attempt).
   */
  negotiator?: ResponseFormatNegotiator;
  /**
   * todo_20 T-210: invoked for EVERY transient upstream retry with its class.
   * The analyze stage uses it to collapse the parallel pool on the first 429
   * (spec П4.2) — even one that a later retry recovers from.
   */
  onUpstreamRetry?: (errorClass: AiCallErrorClass) => void;
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
  /**
   * todo_20 T-201/E1: fail the job with a registry error code — the error
   * object carries code/category/action/resumable; `overrides` refine the
   * user-facing texts (legacy message/hint compatibility). A partial result
   * snapshot is recorded so «что уже создано» is visible on the fail screen.
   */
  failCode(code: AiImportErrorCode, overrides?: { message?: string; hint?: string }): void;
  chat<T>(args: ChatArgs<T>): Promise<JsonCallOutcome<T>>;
  /**
   * todo_20 T-211: persist a checkpoint of the CURRENT job state (atomic write
   * behind the previous one). `mutate` updates run-scoped state (analyze
   * cursor, chunker snapshot) before the snapshot is taken. A cheap no-op when
   * the service runs without a checkpoint repository (unit tests).
   */
  checkpoint(mutate?: (state: AiJobCheckpoint) => void): void;
}
