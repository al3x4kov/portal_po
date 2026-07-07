import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';

/**
 * QA-6 · Perf baseline & trend guard.
 *
 * The hard absolute gates in the perf suite catch a sudden O(n²) blow-up, but
 * they are deliberately generous (fact × ~3) so they do NOT catch a slow,
 * cumulative drift that stays under the ceiling. This module records the
 * measured p50/p95 of every key benchmark as a committed artifact
 * (`perf-baseline.json`) and, on the next run, fails a benchmark whose p95 has
 * grown more than {@link BASELINE_MAX_GROWTH_PCT}% over the recorded baseline —
 * IN ADDITION to the absolute gate.
 *
 * Anti-flake: the comparison uses the p95 of the BEST measurement round (the
 * budget loop re-measures on a settled box and passes on the first round that
 * meets both gates), the default growth threshold is a wide 50 %, and a missing
 * key simply bootstraps (records + passes) instead of failing.
 *
 * Updating the baseline (after an intended perf change or a runner swap):
 *   PERF_BASELINE_UPDATE=1 npx vitest run apps/server/test/perf-archive.test.ts \
 *     apps/server/test/perf-concurrency.test.ts apps/server/test/perf.test.ts
 * then commit the regenerated apps/server/test/perf-baseline.json.
 */

const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-baseline.json');

/** Env: max allowed p95 growth over the baseline before a benchmark fails (%). */
export const BASELINE_MAX_GROWTH_PCT = Number.isFinite(
  Number(process.env.PERF_BASELINE_MAX_GROWTH_PCT),
)
  ? Number(process.env.PERF_BASELINE_MAX_GROWTH_PCT)
  : 50;

/** Env: set truthy to overwrite the baseline entries with the current run. */
export const BASELINE_UPDATE = /^(1|true|yes)$/i.test(process.env.PERF_BASELINE_UPDATE ?? '');

/**
 * The perf benchmarks are HEAVY and time-sensitive: under the default
 * coverage-instrumented `npm test` (v8 instrumentation + all workspaces running
 * in parallel) their p95 inflates 3–6× vs an isolated run, which would make the
 * absolute gates non-deterministic. They are therefore gated OFF by default and
 * run in a dedicated, un-instrumented line: `npm run test:perf` (which sets
 * `RUN_PERF=1`). Under plain `npm test` the perf `describe` blocks are skipped.
 */
export const PERF_DISABLED = process.env.RUN_PERF !== '1';

export interface BaselineEntry {
  p50: number;
  p95: number;
  updatedAt: string;
  note?: string;
}

type BaselineFile = Record<string, BaselineEntry>;

async function readBaselineFile(): Promise<BaselineFile> {
  try {
    const raw = await fs.readFile(BASELINE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? {}) as BaselineFile;
  } catch {
    return {};
  }
}

/**
 * Atomically merge one entry into the baseline file. Serialized across vitest
 * workers with an advisory file lock (`proper-lockfile`, `realpath:false` so it
 * works before the file exists) so parallel benchmark files never clobber each
 * other's bootstrap write, then temp+rename for an atomic replace.
 */
async function writeBaselineEntry(key: string, entry: BaselineEntry): Promise<void> {
  await fs.mkdir(path.dirname(BASELINE_PATH), { recursive: true });
  // Ensure the lock target exists so proper-lockfile can create its marker.
  await fs.appendFile(BASELINE_PATH, '').catch(() => {});
  const release = await lockfile.lock(BASELINE_PATH, {
    realpath: false,
    stale: 20_000,
    retries: { retries: 100, factor: 1.2, minTimeout: 15, maxTimeout: 250, randomize: true },
  });
  try {
    const current = await readBaselineFile();
    current[key] = entry;
    const ordered: BaselineFile = {};
    for (const k of Object.keys(current).sort()) ordered[k] = current[k]!;
    const tmp = `${BASELINE_PATH}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, BASELINE_PATH);
  } finally {
    await release();
  }
}

export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)]!;
}

export function median(xs: readonly number[]): number {
  return percentile(xs, 50);
}

export interface BudgetOptions {
  /** Human label used in log lines. */
  op: string;
  /** Baseline key; when omitted the trend guard is skipped for this metric. */
  baselineKey?: string;
  /** Collect one round of latency samples (ms). */
  collect: () => Promise<number[]>;
  /** Enforced absolute p95 ceiling (ms). */
  gateMs: number;
  /** Enforced absolute single-sample ceiling (ms). */
  hardCapMs: number;
  /** Informational fit-criterion target p95 (ms), logged each round. */
  targetMs?: number;
  /** Measurement rounds; pass on the first in-budget one. */
  rounds?: number;
  /** Cooldown between rounds so a settled box can re-measure (ms). */
  settleMs?: number;
  /** Scale label (e.g. requirement count) for log lines. */
  scale?: number;
  /**
   * Per-metric override of {@link BASELINE_MAX_GROWTH_PCT}. High-variance
   * metrics (e.g. multi-writer lock contention, whose tail swings widely under a
   * parallel suite) use a wider tolerance so the trend guard flags real drift,
   * not scheduler noise.
   */
  growthPct?: number;
}

interface RoundResult {
  samples: number[];
  p50: number;
  p95: number;
  worst: number;
}

function evaluate(op: string, samples: number[], targetMs?: number): RoundResult {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const worst = Math.max(...samples);
  const targetNote =
    targetMs !== undefined
      ? ` (target p95<${targetMs}ms: ${p95 < targetMs ? 'met' : 'MISSED'})`
      : '';
  console.log(
    `[PERF] ${op}: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
      `worst=${worst.toFixed(1)}ms (n=${samples.length})${targetNote}`,
  );
  return { samples, p50, p95, worst };
}

/**
 * Run up to {@link BudgetOptions.rounds} measurement rounds and pass on the
 * first that meets BOTH the absolute gate/hard-cap AND (when a baseline exists)
 * the relative growth threshold. Throws a descriptive Error on failure so
 * vitest marks the test red. On success, bootstraps a missing baseline entry
 * (or overwrites it when PERF_BASELINE_UPDATE is set).
 */
export async function assertPerfBudget(opts: BudgetOptions): Promise<RoundResult> {
  const rounds = opts.rounds ?? 3;
  const settleMs = opts.settleMs ?? 3000;
  const growthPct = opts.growthPct ?? BASELINE_MAX_GROWTH_PCT;
  const baseline = opts.baselineKey ? (await readBaselineFile())[opts.baselineKey] : undefined;
  const growthLimit = baseline ? baseline.p95 * (1 + growthPct / 100) : Infinity;

  let best: RoundResult | undefined;
  for (let round = 1; round <= rounds; round += 1) {
    const samples = await opts.collect();
    const res = evaluate(`${opts.op} (round ${round})`, samples, opts.targetMs);
    // Track the calmest round: a parallel suite spikes early rounds, so the
    // verdict is decided by the best settled measurement, not a transient spike.
    if (!best || res.p95 < best.p95) best = res;
    const absOk = res.p95 < opts.gateMs && res.worst < opts.hardCapMs;
    // In UPDATE mode we are deliberately rewriting the baseline, so the trend
    // gate is bypassed — we only require the round to meet the absolute gate.
    const trendOk = BASELINE_UPDATE ? true : res.p95 <= growthLimit;
    if (baseline) {
      const growth = ((res.p95 - baseline.p95) / baseline.p95) * 100;
      console.log(
        `[PERF-TREND] ${opts.op}: baseline p95=${baseline.p95.toFixed(1)}ms → ` +
          `now ${res.p95.toFixed(1)}ms (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%, ` +
          `limit +${growthPct}%): ${trendOk ? 'ok' : 'REGRESSION'}`,
      );
    }
    if (absOk && trendOk) {
      if (opts.baselineKey && (!baseline || BASELINE_UPDATE)) {
        await writeBaselineEntry(opts.baselineKey, {
          p50: Math.round(res.p50 * 10) / 10,
          p95: Math.round(res.p95 * 10) / 10,
          updatedAt: new Date().toISOString(),
          note: baseline ? 'updated (PERF_BASELINE_UPDATE)' : 'bootstrap',
        });
      }
      return res;
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, settleMs));
  }

  // No round met both gates; the verdict uses the calmest (best-p95) round.
  const r = best!;
  const samplesStr = r.samples.map((s) => s.toFixed(0)).join(',');
  if (!(r.p95 < opts.gateMs) || !(r.worst < opts.hardCapMs)) {
    throw new Error(
      `${opts.op} exceeded ABSOLUTE budget: p95=${r.p95.toFixed(1)}ms (gate ${opts.gateMs}ms), ` +
        `worst=${r.worst.toFixed(1)}ms (cap ${opts.hardCapMs}ms). samples=[${samplesStr}]`,
    );
  }
  throw new Error(
    `${opts.op} REGRESSED vs baseline: p95=${r.p95.toFixed(1)}ms > ` +
      `${growthLimit.toFixed(1)}ms (baseline ${baseline!.p95.toFixed(1)}ms +${growthPct}%). ` +
      `If intended, rerun with PERF_BASELINE_UPDATE=1 and commit perf-baseline.json. samples=[${samplesStr}]`,
  );
}
