import type { Rice, SourceEntry, SourcePriority, TargetQuarter } from '../domain/types.js';
import { parseIsoDate } from '../domain/dates.js';

/** Round `value` to the nearest 0.1 without binary-float drift. */
function roundTenth(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * RICE score of a single estimate: `reach × impact × confidence / effort`,
 * rounded to one decimal (todo_19 §0.3). Pure; reused by server and web.
 */
export function riceScore(r: Rice): number {
  if (r.effort === 0) return 0;
  return roundTenth((r.reach * r.impact * r.confidence) / r.effort);
}

/**
 * Aggregate requirement RICE = the MAX score across sources that carry a RICE
 * estimate. `undefined` when no source has one (todo_19 §0.3 / ФТ-B2).
 */
export function aggregateRiceScore(sources: readonly SourceEntry[]): number | undefined {
  let max: number | undefined;
  for (const s of sources) {
    if (!s.rice) continue;
    const score = riceScore(s.rice);
    if (max === undefined || score > max) max = score;
  }
  return max;
}

/**
 * Aggregate requirement priority = the priorityId of the source whose priority
 * has the smallest `order` (most senior). Sources referencing an unknown
 * priorityId are ignored. `undefined` when no source resolves (todo_19 §0.3).
 */
export function aggregatePriorityId(
  sources: readonly SourceEntry[],
  priorities: readonly SourcePriority[],
): string | undefined {
  const orderOf = new Map(priorities.map((p) => [p.id, p.order]));
  let bestId: string | undefined;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const s of sources) {
    const order = orderOf.get(s.priorityId);
    if (order === undefined) continue;
    if (order < bestOrder) {
      bestOrder = order;
      bestId = s.priorityId;
    }
  }
  return bestId;
}

const QUARTER_OF_MONTH: Record<TargetQuarter, [number, number]> = {
  Q1: [1, 3],
  Q2: [4, 6],
  Q3: [7, 9],
  Q4: [10, 12],
};

/**
 * True when the ISO date `dateISO` falls inside `quarter`/`year`. Never throws
 * — a malformed date returns `false` — so callers can drive a soft warning
 * (todo_19 §0.3 / ФТ-D3) without try/catch.
 */
export function isDateInQuarter(dateISO: string, quarter: TargetQuarter, year: number): boolean {
  const parsed = parseIsoDate(dateISO);
  if (!parsed) return false;
  if (parsed.year !== year) return false;
  const [lo, hi] = QUARTER_OF_MONTH[quarter];
  return parsed.month >= lo && parsed.month <= hi;
}
