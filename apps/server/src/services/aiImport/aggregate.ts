import {
  breakParentCycles,
  nameKey,
  unionRelatedFunctions,
  type AiExtractedRequirement,
  type Requirement,
} from '@po/core';
import type { AggregatedRecord } from './types.js';

/** Structured tree shape after parent resolution and cycle breaking (Task 14 B6). */
export interface TreeSummary {
  fnRoots: number;
  fnChildren: number;
  nfrRoots: number;
  nfrChildren: number;
  maxDepth: number;
}

/**
 * Structural events emitted by {@link aggregateRequirements}, in emission order.
 * They carry data only — the RU-log wording lives in {@link renderAggregateEvent}
 * so the algorithm and its user-facing text are independently testable.
 */
export type AggregateEvent =
  | { kind: 'duplicates'; names: string[] }
  | { kind: 'parentOtherType'; childName: string; parentName: string }
  | { kind: 'parentNotFound'; childName: string; parentName: string }
  | { kind: 'cycleBroken'; childName: string }
  | { kind: 'treeSummary'; summary: TreeSummary }
  | { kind: 'aggregatedCount'; count: number };

export interface AggregateResult {
  aggregated: AggregatedRecord[];
  events: AggregateEvent[];
}

/**
 * Task 14 B6: one-line tree summary after parent resolution and cycle breaking.
 * Depth: a root is 1; a parent outside the aggregated set (an already-existing
 * project requirement) counts as depth 1. Cycles are already broken, so the
 * walk terminates. Pure.
 */
export function summarizeTree(aggregated: AggregatedRecord[]): TreeSummary {
  const parentOf = new Map<string, string>();
  for (const item of aggregated) {
    if (item.parentKey) {
      parentOf.set(nameKey(item.record.type, item.record.name), item.parentKey);
    }
  }
  const depthOf = (key: string): number => {
    let depth = 1;
    for (let cur = parentOf.get(key); cur !== undefined; cur = parentOf.get(cur)) depth += 1;
    return depth;
  };
  let fnRoots = 0;
  let fnChildren = 0;
  let nfrRoots = 0;
  let nfrChildren = 0;
  let maxDepth = 0;
  for (const item of aggregated) {
    const isChild = item.parentKey !== undefined;
    if (item.record.type === 'FUNCTION') {
      if (isChild) fnChildren += 1;
      else fnRoots += 1;
    } else if (isChild) nfrChildren += 1;
    else nfrRoots += 1;
    const depth = depthOf(nameKey(item.record.type, item.record.name));
    if (depth > maxDepth) maxDepth = depth;
  }
  return { fnRoots, fnChildren, nfrRoots, nfrChildren, maxDepth };
}

/**
 * Stage «aggregate» core (pure): dedup extracted records by (type, name),
 * resolve same-type parents from the structure answer, deterministically break
 * cycles, and produce the records to populate plus an ordered list of events.
 * No I/O, no logging, no AI — fully unit-testable in isolation.
 */
export function aggregateRequirements(input: {
  extracted: AiExtractedRequirement[];
  existing: Requirement[];
  structureParentByKey: ReadonlyMap<string, string | null>;
}): AggregateResult {
  const { extracted, existing, structureParentByKey } = input;
  const events: AggregateEvent[] = [];

  const byKey = new Map<string, AiExtractedRequirement>();
  const duplicateNames: string[] = [];
  for (const record of extracted) {
    const key = nameKey(record.type, record.name);
    const prev = byKey.get(key);
    if (prev) {
      duplicateNames.push(record.name.trim());
      // Task 15: duplicates of one NFR merge their relatedFunctions
      // (union by case-insensitive name, first formulation kept).
      const merged = unionRelatedFunctions(prev.relatedFunctions, record.relatedFunctions);
      if (merged !== prev.relatedFunctions) {
        byKey.set(key, { ...prev, relatedFunctions: merged });
      }
    } else {
      byKey.set(key, record);
    }
  }
  if (duplicateNames.length > 0) {
    // Surface silently dropped in-run duplicates (they are NOT counted in
    // skippedExisting — the aiImportResultSchema contract is stable).
    events.push({ kind: 'duplicates', names: duplicateNames });
  }

  const existingKeys = new Map<string, Requirement>();
  for (const req of existing) existingKeys.set(nameKey(req.type, req.name), req);

  // Task 13 B2: the parent comes from the structure stage ONLY. Task 14 B6:
  // resolve parents first (same-type only), then break cycles BEFORE anything
  // is written.
  const parentInfoByKey = new Map<string, { parentKey: string; parentName: string }>();
  for (const record of byKey.values()) {
    const key = nameKey(record.type, record.name);
    const parentName = structureParentByKey.get(key);
    if (!parentName) continue; // root (explicit null or not covered)
    const parentKey = nameKey(record.type, parentName);
    if (parentKey === key) continue; // self-parent
    if (byKey.has(parentKey) || existingKeys.has(parentKey)) {
      parentInfoByKey.set(key, { parentKey, parentName });
      continue;
    }
    const otherType = record.type === 'FUNCTION' ? 'NFR' : 'FUNCTION';
    const otherKey = nameKey(otherType, parentName);
    if (byKey.has(otherKey) || existingKeys.has(otherKey)) {
      events.push({ kind: 'parentOtherType', childName: record.name, parentName });
    } else {
      events.push({ kind: 'parentNotFound', childName: record.name, parentName });
    }
  }

  const parentKeyByChild = new Map<string, string>();
  for (const [key, info] of parentInfoByKey) parentKeyByChild.set(key, info.parentKey);
  for (const childKey of breakParentCycles(parentKeyByChild)) {
    const childName = byKey.get(childKey)?.name ?? childKey;
    events.push({ kind: 'cycleBroken', childName });
    parentInfoByKey.delete(childKey);
  }

  const aggregated: AggregatedRecord[] = [];
  for (const record of byKey.values()) {
    const info = parentInfoByKey.get(nameKey(record.type, record.name));
    aggregated.push({ record, parentKey: info?.parentKey, parentName: info?.parentName });
  }
  if (aggregated.length > 0) {
    events.push({ kind: 'treeSummary', summary: summarizeTree(aggregated) });
  }
  events.push({ kind: 'aggregatedCount', count: aggregated.length });

  return { aggregated, events };
}

/** Render one aggregate event to its RU log line (wording separated from the algorithm). */
export function renderAggregateEvent(event: AggregateEvent): {
  level: 'info' | 'warn';
  message: string;
} {
  switch (event.kind) {
    case 'duplicates':
      return {
        level: 'warn',
        message:
          `Дубликатов в извлечении пропущено: ${event.names.length} ` +
          `(повторы по (тип, имя): ${event.names.map((n) => `«${n}»`).join(', ')}).`,
      };
    case 'parentOtherType':
      return {
        level: 'warn',
        message: `«${event.childName}»: родитель «${event.parentName}» имеет другой тип — иерархия допустима только внутри одного типа; пропущена.`,
      };
    case 'parentNotFound':
      return {
        level: 'warn',
        message: `«${event.childName}»: родитель «${event.parentName}» не найден ни в извлечённом наборе, ни в проекте — иерархия пропущена.`,
      };
    case 'cycleBroken':
      return { level: 'warn', message: `Цикл разорван: «${event.childName}» становится корневым.` };
    case 'treeSummary': {
      const s = event.summary;
      return {
        level: 'info',
        message:
          `Дерево: ФТ — ${s.fnRoots} корней, ${s.fnChildren} с родителем; ` +
          `НФТ — ${s.nfrRoots} корней, ${s.nfrChildren} с родителем; максимальная глубина ${s.maxDepth}.`,
      };
    }
    case 'aggregatedCount':
      return { level: 'info', message: `К наполнению после агрегации: ${event.count} требований.` };
  }
}
