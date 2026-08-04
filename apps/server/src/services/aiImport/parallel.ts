/**
 * todo_20 · T-210: parallel-call pool governor (spec П4.2, C2).
 *
 * The analyze stage runs up to `preset.parallelism` chunk calls at once. The
 * FIRST 429 seen by the retry wrapper collapses the pool to K=1 (the upstream
 * is telling us to slow down); a streak of successful chunks then restores the
 * pool one step at a time back to the preset. The governor is consulted before
 * every dispatch, so the change takes effect at the next chunk boundary.
 */

/** Successful chunks in a row that earn one +1 step of pool recovery. */
export const AI_PARALLELISM_RECOVERY_SUCCESSES = 3;

export class ParallelismGovernor {
  private current: number;
  private successStreak = 0;

  constructor(private readonly max: number) {
    this.current = Math.max(1, max);
  }

  /** Current pool size (dispatch at most this many chunks at once). */
  limit(): number {
    return this.current;
  }

  /** The preset ceiling the pool recovers towards (todo_23 M4: for log lines). */
  presetLimit(): number {
    return this.max;
  }

  /**
   * The upstream signalled overload — a 429 or a per-call timeout (todo_23
   * M4), even one that a retry later recovered. Collapses the pool to 1;
   * returns true when this call actually changed the size (the caller logs
   * the degradation exactly once, E3).
   */
  noteRateLimited(): boolean {
    this.successStreak = 0;
    if (this.current === 1) return false;
    this.current = 1;
    return true;
  }

  /**
   * A chunk finished successfully — gradual recovery towards the preset:
   * +1 after every {@link AI_PARALLELISM_RECOVERY_SUCCESSES} successes in a
   * row. Returns true when the effective K actually changed (todo_23 M4: the
   * caller logs every change of the effective parallelism).
   */
  noteSuccess(): boolean {
    if (this.current >= this.max) return false;
    this.successStreak += 1;
    if (this.successStreak >= AI_PARALLELISM_RECOVERY_SUCCESSES) {
      this.successStreak = 0;
      this.current = Math.min(this.max, this.current + 1);
      return true;
    }
    return false;
  }
}
