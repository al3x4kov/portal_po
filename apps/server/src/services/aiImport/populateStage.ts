import { DomainError, nameKey, type Requirement } from '@po/core';
import type { LinkServicePort, RequirementServicePort } from '../ports.js';
import { AI_IMPORT_DEFAULT_CRITICALITY, AI_IMPORT_HINT_POPULATE } from './constants.js';
import type { AggregatedRecord, AiImportRuntime, LinkCandidate } from './types.js';

export interface PopulateInput {
  aggregated: AggregatedRecord[];
  existing: Requirement[];
  requirementService: RequirementServicePort;
  linkService: LinkServicePort;
}

export type PopulateOutcome = { ok: true } | { ok: false };

/**
 * Stage «populate» (progress 85–100). Creates the aggregated requirements
 * through the existing RequirementService (so every core rule applies), then
 * the resolved CHILD_OF hierarchy and the explicit-mention RELATES_TO links.
 * Idempotent on re-runs: existing requirements/links are never rewritten or
 * duplicated. Mutates `rt.counters`. Returns `ok:false` only on cancellation.
 */
export async function runPopulateStage(
  rt: AiImportRuntime,
  input: PopulateInput,
): Promise<PopulateOutcome> {
  const { job, counters } = rt;
  const { aggregated, existing, requirementService, linkService } = input;
  job.stage = 'populate';
  if (rt.cancelled()) return { ok: false };

  const existingKeys = new Map<string, Requirement>();
  for (const req of existing) existingKeys.set(nameKey(req.type, req.name), req);
  const slugByKey = new Map<string, string>();
  for (const req of existing) slugByKey.set(nameKey(req.type, req.name), req.slug);

  const linkCandidates: LinkCandidate[] = [];
  // Task 15: NFRs whose extraction carries relatedFunctions — resolved
  // into RELATES_TO links after the CHILD_OF pass.
  const relatesCandidates: LinkCandidate[] = [];
  let processed = 0;
  for (const item of aggregated) {
    const { record } = item;
    const key = nameKey(record.type, record.name);
    processed += 1;
    if (record.relatedFunctions?.length && record.type !== 'NFR') {
      // Guard against a hallucinated field on a FUNCTION record (Task 15):
      // the binding is only meaningful FROM an NFR.
      rt.log(
        'warn',
        `«${record.name}» (${record.type}): relatedFunctions игнорируется — привязка допустима только от НФТ.`,
      );
    }
    const wantsRelates = record.type === 'NFR' && (record.relatedFunctions?.length ?? 0) > 0;
    const existingReq = existingKeys.get(key);
    if (existingReq) {
      counters.skippedExisting += 1;
      rt.log(
        'warn',
        `«${record.name}» (${record.type}) уже существует в проекте — пропущено, файл не изменён.`,
      );
      // Re-run survivability: the requirement is not rewritten, but its
      // extracted CHILD_OF is still ensured below when it is missing.
      if (item.parentKey) linkCandidates.push({ item, existingLinks: existingReq.links });
      // Task 15: same completion semantics for RELATES_TO — the links
      // snapshot lets the loop below skip already-present pairs (RELATES_TO
      // is symmetric, so the NFR endpoint always carries its half).
      if (wantsRelates) relatesCandidates.push({ item, existingLinks: existingReq.links });
      continue;
    }
    if (wantsRelates) relatesCandidates.push({ item });

    const criticality = record.criticality ?? AI_IMPORT_DEFAULT_CRITICALITY;
    const defaults: string[] = [];
    if (!record.criticality) defaults.push(`критичность=${AI_IMPORT_DEFAULT_CRITICALITY}`);
    if (defaults.length > 0) {
      rt.log(
        'warn',
        `«${record.name}»: в источнике не указано — применены умолчания: ${defaults.join(', ')}.`,
      );
    }

    try {
      // Task 13 A1/A2: `source` stays EMPTY (it is a business field — the file
      // provenance lives in the job log only) and everything imported is
      // created as already implemented, so no target quarter/year (core
      // rules.ts allows them only when implemented=false).
      const created = await requirementService.create({
        type: record.type,
        name: record.name,
        criticality,
        description: record.description,
        implemented: true,
        // task26: provenance is stamped at creation time, through the service —
        // never patched onto the `.md` afterwards.
        origin: 'AI_DOCS',
      });
      slugByKey.set(key, created.slug);
      if (item.parentKey) linkCandidates.push({ item });
      if (record.type === 'FUNCTION') counters.createdFunctions += 1;
      else counters.createdNfrs += 1;
      rt.log('info', `Создано: «${record.name}» (${record.type}).`);
    } catch (err) {
      if (err instanceof DomainError) {
        rt.log(
          'warn',
          `«${record.name}» не создано (${err.code}): ${err.message} ${AI_IMPORT_HINT_POPULATE}`,
        );
      } else {
        throw err;
      }
    }
    job.progress = Math.min(99, 85 + Math.round((14 * processed) / aggregated.length));
  }

  // CHILD_OF links whose parent resolved: for created records AND for skipped
  // existing ones missing their extracted link (so a re-run after a crash
  // between requirements and links completes the hierarchy).
  for (const { item, existingLinks } of linkCandidates) {
    if (!item.parentKey) continue;
    const sourceSlug = slugByKey.get(nameKey(item.record.type, item.record.name));
    const targetSlug = slugByKey.get(item.parentKey);
    if (!sourceSlug || !targetSlug) continue;
    // PO decision §3 (todo_18): on an EXISTING requirement the hierarchy is only
    // GAP-FILLED — a node that already has a CHILD_OF parent (manual or prior)
    // is NEVER reparented. We add CHILD_OF only where the existing node is still
    // a root (no parent at all). Freshly-created records have no existingLinks
    // and always get their resolved parent.
    if (existingLinks?.some((l) => l.type === 'CHILD_OF')) {
      continue; // existing parent/hierarchy left intact
    }
    try {
      await linkService.create({ sourceSlug, type: 'CHILD_OF', targetSlug });
      counters.links += 1;
      if (existingLinks) {
        rt.log(
          'info',
          `Достроена недостающая связь CHILD_OF: «${item.record.name}» → «${item.parentName}».`,
        );
      }
    } catch (err) {
      if (err instanceof DomainError) {
        rt.log(
          'warn',
          `Связь CHILD_OF «${item.record.name}» → «${item.parentName}» не создана (${err.code}): ${err.message}`,
        );
      } else {
        throw err;
      }
    }
  }

  // Task 15: RELATES_TO links from an NFR to the functions it explicitly
  // constrains. Targets resolve case-insensitively through slugByKey, so both
  // functions created by THIS import and ones that already existed in the
  // project are reachable. For skipped existing NFRs the links snapshot keeps
  // re-runs idempotent: a present pair (RELATES_TO is symmetric — the NFR
  // endpoint always stores its half) is never touched or duplicated.
  for (const { item, existingLinks } of relatesCandidates) {
    const { record } = item;
    const sourceSlug = slugByKey.get(nameKey(record.type, record.name));
    if (!sourceSlug) continue; // the NFR itself failed to create
    const seenTargets = new Set<string>();
    for (const fnName of record.relatedFunctions ?? []) {
      const fnKey = nameKey('FUNCTION', fnName);
      if (seenTargets.has(fnKey)) continue; // in-record duplicate
      seenTargets.add(fnKey);
      if (rt.cancelled()) return { ok: false };
      const targetSlug = slugByKey.get(fnKey);
      if (!targetSlug) {
        rt.log(
          'warn',
          `НФТ «${record.name}»: связанная ФТ «${fnName}» не найдена — связь пропущена.`,
        );
        continue;
      }
      if (existingLinks?.some((l) => l.type === 'RELATES_TO' && l.targetSlug === targetSlug)) {
        continue; // link already present — existing links are never touched
      }
      try {
        await linkService.create({ sourceSlug, type: 'RELATES_TO', targetSlug });
        counters.relatesLinks += 1;
        rt.log('info', `Связано: НФТ «${record.name}» → ФТ «${fnName}» (RELATES_TO).`);
      } catch (err) {
        if (err instanceof DomainError) {
          rt.log(
            'warn',
            `Связь RELATES_TO «${record.name}» → «${fnName}» не создана (${err.code}): ${err.message}`,
          );
        } else {
          throw err;
        }
      }
    }
  }

  return { ok: true };
}
