/**
 * todo_20 · T-213: remaining-time estimate (spec П6.4, решение PO №6).
 *
 * The ETA is throughput-based: after the FIRST successfully committed chunks
 * it extrapolates `(elapsed / completed) × remaining`. Before that it reports
 * `null` — the UI renders «оценивается…». Wall-clock throughput is correct
 * under parallelism too (K workers simply raise the observed chunk rate).
 */
export class EtaTracker {
  private startedAtMs: number | undefined;
  private completed = 0;

  constructor(private total: number) {}

  /** More work discovered mid-run (chunk splits, repeat passes). */
  addChunks(count: number): void {
    this.total += count;
  }

  /** First dispatch of the run — starts the wall clock. */
  start(nowMs: number): void {
    this.startedAtMs ??= nowMs;
  }

  /** One chunk committed. */
  noteDone(): void {
    this.completed += 1;
  }

  /** Remaining seconds, or `null` while there is nothing to extrapolate from. */
  etaSeconds(nowMs: number): number | null {
    if (this.completed === 0 || this.startedAtMs === undefined) return null;
    const perChunkMs = (nowMs - this.startedAtMs) / this.completed;
    const remaining = Math.max(0, this.total - this.completed);
    return Math.max(0, Math.round((perChunkMs * remaining) / 1000));
  }
}
