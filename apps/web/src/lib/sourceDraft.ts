import {
  RICE_CONFIDENCE,
  RICE_EFFORT,
  RICE_IMPACT,
  RICE_REACH,
  riceScore,
  type Rice,
  type SourceEntry,
  type SourcePriority,
  type SourceType,
  type TargetQuarter,
} from '@po/core';

/**
 * Editable in-modal representation of one requirement source. Unlike the
 * persisted {@link SourceEntry}, RICE fields are individually optional so a
 * half-filled estimate does not force an invalid payload; a stable `_key` keeps
 * React list identity across re-orders (todo_19 T-205).
 */
export interface SourceDraft {
  _key: string;
  type: SourceType;
  name: string;
  priorityId: string;
  reach?: number;
  impact?: number;
  confidence?: number;
  effort?: number;
  targetQuarter?: TargetQuarter;
  targetYear?: number;
  targetDate?: string;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `src-${keySeq}-${Date.now().toString(36)}`;
}

/** Default priorityId for a new source = the most senior (min `order`) entry. */
export function defaultPriorityId(priorities: readonly SourcePriority[]): string {
  const sorted = [...priorities].sort((a, b) => a.order - b.order);
  return sorted[0]?.id ?? 'default';
}

/** A blank draft seeded with the senior default priority. */
export function emptyDraft(priorities: readonly SourcePriority[]): SourceDraft {
  return {
    _key: nextKey(),
    type: 'CLIENT',
    name: '',
    priorityId: defaultPriorityId(priorities),
  };
}

/** Convert a persisted source into an editable draft. */
export function toDraft(entry: SourceEntry): SourceDraft {
  return {
    _key: nextKey(),
    type: entry.type,
    name: entry.name,
    priorityId: entry.priorityId,
    reach: entry.rice?.reach,
    impact: entry.rice?.impact,
    confidence: entry.rice?.confidence,
    effort: entry.rice?.effort,
    targetQuarter: entry.targetQuarter,
    targetYear: entry.targetYear,
    targetDate: entry.targetDate,
  };
}

/** All four RICE fields present → a complete estimate, else undefined. */
export function draftRice(d: SourceDraft): Rice | undefined {
  if (
    d.reach !== undefined &&
    d.impact !== undefined &&
    d.confidence !== undefined &&
    d.effort !== undefined
  ) {
    return { reach: d.reach, impact: d.impact, confidence: d.confidence, effort: d.effort };
  }
  return undefined;
}

/** Live RICE score of a draft (undefined until all four fields are set). */
export function draftScore(d: SourceDraft): number | undefined {
  const rice = draftRice(d);
  return rice ? riceScore(rice) : undefined;
}

/**
 * Serialise drafts to the persisted `sources[]` payload, dropping unnamed
 * drafts and omitting empty optional fields (so the .md stays lean / lossless).
 */
export function draftsToSources(drafts: readonly SourceDraft[]): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const d of drafts) {
    const name = d.name.trim();
    if (name.length === 0) continue;
    const entry: SourceEntry = { type: d.type, name, priorityId: d.priorityId };
    const rice = draftRice(d);
    if (rice) entry.rice = rice;
    if (d.targetQuarter) entry.targetQuarter = d.targetQuarter;
    if (d.targetYear !== undefined) entry.targetYear = d.targetYear;
    if (d.targetDate && d.targetDate.length > 0) entry.targetDate = d.targetDate;
    out.push(entry);
  }
  return out;
}

/** Same serialisation, exposed for the live aggregate (keeps RICE-carrying drafts). */
export function draftsForAggregate(drafts: readonly SourceDraft[]): SourceEntry[] {
  return draftsToSources(drafts);
}

/* ── RICE select option labels (mirrors the mockup wording) ───────────────── */

export const REACH_OPTIONS = RICE_REACH.map((v) => ({
  value: v,
  label:
    v === 1
      ? '1 · единичные'
      : v === 2
        ? '2 · малая группа'
        : v === 3
          ? '3 · заметная часть'
          : v === 4
            ? '4 · большинство'
            : '5 · почти все',
}));

export const IMPACT_OPTIONS = RICE_IMPACT.map((v) => ({ value: v, label: String(v) }));

export const CONFIDENCE_OPTIONS = RICE_CONFIDENCE.map((v) => ({
  value: v,
  label: v === 0.5 ? '50%' : v === 0.8 ? '80%' : '100%',
}));

export const EFFORT_OPTIONS = RICE_EFFORT.map((v) => ({ value: v, label: String(v) }));
