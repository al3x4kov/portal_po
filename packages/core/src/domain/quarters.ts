import { TARGET_QUARTERS, type TargetQuarter } from './types.js';

/**
 * Next calendar quarter after `nowIso` (default target for an unimplemented
 * requirement). Computed in UTC: the quarter index rolls over from Q4 back to
 * Q1 of the following year.
 */
export function nextQuarterOf(nowIso: string): {
  targetQuarter: TargetQuarter;
  targetYear: number;
} {
  const date = new Date(nowIso);
  const quarterIndex = Math.floor(date.getUTCMonth() / 3); // 0..3
  const nextIndex = (quarterIndex + 1) % 4;
  const targetYear = nextIndex === 0 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  return { targetQuarter: TARGET_QUARTERS[nextIndex] as TargetQuarter, targetYear };
}
