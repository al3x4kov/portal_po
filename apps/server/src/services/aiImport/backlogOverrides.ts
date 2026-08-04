import { aiBacklogOverrideSchema, type AiBacklogReview, type Requirement } from '@po/core';
import { BadRequestError } from '../../lib/errors.js';
import { normalizeRequirementName } from './dedupe.js';

/**
 * task25 · merge the review-step edits (`overrides` of the apply body) into
 * the saved mappings BEFORE populate. Pure with respect to its inputs: the
 * review is cloned, never mutated — the caller decides what to persist.
 *
 * Validation (each failure → {@link BadRequestError}, HTTP 400, with the rowId
 * in the text so the review step can point at the offending row):
 * - an override key must be one of the SELECTED rows (`rowIds`);
 * - the override payload must satisfy {@link aiBacklogOverrideSchema}
 *   (non-empty trimmed names, target as a pair, year 2020–2100);
 * - `parent.kind='existing'` must name a real tree node of the ROW'S type
 *   (CHILD_OF links live inside one type) — matched with the same name
 *   normalization the populate stage uses;
 * - `parent.kind='new'` goes through the same normalization/dedup as the
 *   model's proposed nodes: a normalized match reuses that node (never a
 *   duplicate), otherwise a new ROOT node is added (v1 — root only).
 *
 * A target edit clears `targetFromFile` (the 📄 marker) — the value no longer
 * comes from the file. `newNodes.rowCount` is recomputed from the merged
 * mappings so the review/report stays honest after reparenting.
 */
export function mergeBacklogOverrides(
  review: AiBacklogReview,
  rawOverrides: Record<string, unknown>,
  selectedRowIds: ReadonlySet<string>,
  existing: readonly Requirement[],
): AiBacklogReview {
  const merged = structuredClone(review);
  const byRowId = new Map(merged.mappings.map((m) => [m.rowId, m]));
  const existingByTypeKey = new Set(
    existing.map((r) => `${r.type}:${normalizeRequirementName(r.name)}`),
  );
  const nodeByKey = new Map(merged.newNodes.map((n) => [normalizeRequirementName(n.name), n]));

  for (const [rowId, raw] of Object.entries(rawOverrides)) {
    const mapping = byRowId.get(rowId);
    if (!selectedRowIds.has(rowId) || mapping === undefined) {
      throw new BadRequestError(
        `Правка для строки «${rowId}» не входит в выбранные строки (rowIds).`,
      );
    }
    const parsed = aiBacklogOverrideSchema.safeParse(raw);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? 'некорректный формат правки';
      throw new BadRequestError(`Правка строки «${rowId}» отклонена: ${reason}.`);
    }
    const ov = parsed.data;
    if (ov.businessName !== undefined) mapping.businessName = ov.businessName;
    if (ov.targetQuarter !== undefined && ov.targetYear !== undefined) {
      mapping.targetQuarter = ov.targetQuarter;
      mapping.targetYear = ov.targetYear;
      mapping.targetFromFile = false; // the edit replaces the file-provided value
    }
    if (ov.parent !== undefined) {
      if (ov.parent.kind === 'existing') {
        const key = `${mapping.type}:${normalizeRequirementName(ov.parent.name)}`;
        if (!existingByTypeKey.has(key)) {
          throw new BadRequestError(
            `Строка «${rowId}»: узел «${ov.parent.name}» не найден среди существующих узлов типа ${mapping.type}.`,
          );
        }
        mapping.parent = { kind: 'existing', name: ov.parent.name };
      } else {
        const key = normalizeRequirementName(ov.parent.name);
        const proposed = nodeByKey.get(key);
        if (proposed !== undefined) {
          // Same node the model proposed — reuse it, keep its exact spelling.
          mapping.parent = { kind: 'new', name: proposed.name, parentName: proposed.parentName };
        } else {
          const fresh = { name: ov.parent.name, parentName: null, rowCount: 0 };
          merged.newNodes.push(fresh);
          nodeByKey.set(key, fresh);
          mapping.parent = { kind: 'new', name: fresh.name, parentName: null };
        }
      }
    }
  }

  // Keep the per-node row counters honest after reparenting.
  for (const node of merged.newNodes) node.rowCount = 0;
  for (const m of merged.mappings) {
    if (m.parent.kind !== 'new') continue;
    const node = nodeByKey.get(normalizeRequirementName(m.parent.name));
    if (node !== undefined) node.rowCount += 1;
  }
  return merged;
}
