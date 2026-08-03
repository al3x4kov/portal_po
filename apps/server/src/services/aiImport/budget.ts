import type { AiImportUsageView } from '@po/core';

/**
 * todo_20 · T-208: run token budget (spec П3.6, B6).
 *
 * Accumulates `usage` from every AI answer and reports when the run exceeds
 * `preset.runBudgetTokens`. The STAGE decides what «exceeded» means: a soft
 * stop with BUDGET-01 (resumable) at the next chunk boundary — never a hard
 * abort mid-call. `null` = no limit; `0` = stop after the first spend.
 * Serializable for the job checkpoint (T-211, волна 1.2).
 */

/** OpenAI-compatible usage block of one chat completion answer. */
export interface UpstreamUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

/** Serializable tracker state. */
export interface BudgetTrackerState {
  limit: number | null;
  promptTokens: number;
  completionTokens: number;
}

export class BudgetTracker {
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(private readonly limit: number | null) {}

  /** Add the usage of one answer; tolerates absent/partial usage blocks. */
  add(usage: UpstreamUsage | undefined | null): void {
    if (!usage) return;
    this.promptTokens += usage.prompt_tokens ?? 0;
    this.completionTokens += usage.completion_tokens ?? 0;
  }

  totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  /** True when the accumulated spend went over the limit. */
  exceeded(): boolean {
    if (this.limit === null) return false;
    return this.totalTokens() > this.limit;
  }

  /** Client-facing usage counters ({@link AiImportUsageView}). */
  view(): AiImportUsageView {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens };
  }

  toJSON(): BudgetTrackerState {
    return {
      limit: this.limit,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    };
  }

  static fromJSON(state: BudgetTrackerState): BudgetTracker {
    const tracker = new BudgetTracker(state.limit);
    tracker.promptTokens = state.promptTokens;
    tracker.completionTokens = state.completionTokens;
    return tracker;
  }
}
