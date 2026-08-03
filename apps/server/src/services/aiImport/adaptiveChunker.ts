import { chunkText } from '../aiImportPrompt.js';

/**
 * todo_20 · T-205: adaptive input chunking for weak models (spec П3.1, B1).
 *
 * The chunk size starts at `preset.chunkChars` and HALVES when the model
 * signals overload: `finish_reason=length`, two invalid-JSON answers in a row,
 * or a context-length error. A streak of successes gradually restores the
 * size back towards the preset. The state is plain JSON so a checkpoint
 * (волна 1.2, T-211) can persist and restore it across server restarts.
 *
 * A context-length error at the MINIMUM size is a terminal signal: the caller
 * must fail the job with MODEL-02 instead of looping forever (приёмка №4).
 */

/** Minimum chunk size, chars (архитектурное допущение T-205). */
export const AI_IMPORT_MIN_CHUNK_CHARS = 2000;
/** Successes in a row that earn one size-doubling step back to the preset. */
export const AI_IMPORT_RECOVERY_SUCCESSES = 3;
/** Invalid-JSON answers in a row that trigger one halving. */
export const AI_IMPORT_INVALID_JSON_HALVE_AFTER = 2;

/** Serializable state of the chunker (goes into the job checkpoint). */
export interface AdaptiveChunkerState {
  initialChars: number;
  minChars: number;
  currentChars: number;
  invalidJsonStreak: number;
  successStreak: number;
}

/** Outcome of one degradation/measurement event. */
export interface HalveOutcome {
  /** True when the chunk size was actually reduced by this event. */
  halved: boolean;
  /** True when the size is (now) at the minimum — no further shrinking. */
  atMinimum: boolean;
}

export interface AdaptiveChunkerOptions {
  /** Start size — `preset.chunkChars`. */
  initialChars: number;
  minChars?: number;
}

export class AdaptiveChunker {
  private state: AdaptiveChunkerState;

  constructor(opts: AdaptiveChunkerOptions) {
    const minChars = opts.minChars ?? AI_IMPORT_MIN_CHUNK_CHARS;
    this.state = {
      initialChars: opts.initialChars,
      minChars: Math.min(minChars, opts.initialChars),
      currentChars: opts.initialChars,
      invalidJsonStreak: 0,
      successStreak: 0,
    };
  }

  /** Current effective chunk size, chars. */
  chunkSize(): number {
    return this.state.currentChars;
  }

  /** True when no further shrinking is possible. */
  atMinimum(): boolean {
    return this.state.currentChars <= this.state.minChars;
  }

  /** Split a text into chunks of the CURRENT size (line-boundary aware). */
  split(text: string): string[] {
    return chunkText(text, this.state.currentChars);
  }

  private halve(): HalveOutcome {
    this.state.successStreak = 0;
    this.state.invalidJsonStreak = 0;
    if (this.atMinimum()) return { halved: false, atMinimum: true };
    this.state.currentChars = Math.max(
      this.state.minChars,
      Math.floor(this.state.currentChars / 2),
    );
    return { halved: true, atMinimum: this.atMinimum() };
  }

  /** The model's context window rejected the input (`400 context_length`). */
  noteContextLength(): HalveOutcome {
    return this.halve();
  }

  /** The answer was truncated by the token limit (`finish_reason=length`). */
  noteTruncated(): HalveOutcome {
    return this.halve();
  }

  /**
   * The answer was not parseable JSON. Halves only after
   * {@link AI_IMPORT_INVALID_JSON_HALVE_AFTER} such answers IN A ROW.
   */
  noteInvalidJson(): HalveOutcome {
    this.state.successStreak = 0;
    this.state.invalidJsonStreak += 1;
    if (this.state.invalidJsonStreak >= AI_IMPORT_INVALID_JSON_HALVE_AFTER) {
      return this.halve();
    }
    return { halved: false, atMinimum: this.atMinimum() };
  }

  /**
   * A successful, parsed answer. After {@link AI_IMPORT_RECOVERY_SUCCESSES}
   * in a row the size doubles one step back towards the preset.
   */
  noteSuccess(): void {
    this.state.invalidJsonStreak = 0;
    if (this.state.currentChars >= this.state.initialChars) return;
    this.state.successStreak += 1;
    if (this.state.successStreak >= AI_IMPORT_RECOVERY_SUCCESSES) {
      this.state.successStreak = 0;
      this.state.currentChars = Math.min(this.state.initialChars, this.state.currentChars * 2);
    }
  }

  /** Plain-JSON snapshot for the job checkpoint (T-211, волна 1.2). */
  toJSON(): AdaptiveChunkerState {
    return { ...this.state };
  }

  /** Restore a chunker from a checkpoint snapshot. */
  static fromJSON(state: AdaptiveChunkerState): AdaptiveChunker {
    const chunker = new AdaptiveChunker({
      initialChars: state.initialChars,
      minChars: state.minChars,
    });
    chunker.state = { ...state };
    return chunker;
  }
}
