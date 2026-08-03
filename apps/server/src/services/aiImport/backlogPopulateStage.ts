import {
  DomainError,
  type AiBacklogReport,
  type AiBacklogReview,
  type AiImportUsageView,
  type Requirement,
  type RequirementType,
  type TargetQuarter,
} from '@po/core';
import type { LinkServicePort, RequirementServicePort } from '../ports.js';
import { AI_IMPORT_DEFAULT_CRITICALITY } from './constants.js';
import { normalizeRequirementName } from './dedupe.js';
import type { AiImportRuntime } from './types.js';

/**
 * todo_22 · T-304: запись выбранных строк бэклога в проект (П4, PO №1/№2/№4).
 *
 * Runs ONLY after the review gate (`apply {rowIds}`): (1) new business nodes
 * in parent→child order, (2) requirements of the selected rows, (3) CHILD_OF
 * links, (4) every created item carries a `BACKLOG` SourceEntry with the
 * project's default dictionary priority. Everything goes through the EXISTING
 * RequirementService/LinkService so every core rule applies. Idempotent: a
 * re-run (crash recovery / repeated apply) recognizes its own creations by
 * (type, name, description) and never duplicates them; a name collision with
 * a FOREIGN requirement gets the deterministic « (N)» suffix.
 */

export interface BacklogPopulateInput {
  review: AiBacklogReview;
  selectedRowIds: ReadonlySet<string>;
  fileName: string;
  requirementService: RequirementServicePort;
  linkService: LinkServicePort;
  /** Default priority id of the project dictionary (PO decision №4). */
  defaultPriorityId: string;
  /** Target for the created NODES (they have no file-provided target). */
  nodeTarget: { quarter: TargetQuarter; year: number };
  usage: AiImportUsageView;
}

export type BacklogPopulateOutcome = { ok: true; report: AiBacklogReport } | { ok: false };

interface CreatedCounters {
  functions: number;
  nfrs: number;
  links: number;
  newNodes: number;
}

export async function runBacklogPopulateStage(
  rt: AiImportRuntime,
  input: BacklogPopulateInput,
): Promise<BacklogPopulateOutcome> {
  const { job } = rt;
  job.stage = 'populate';
  if (rt.cancelled()) return { ok: false };

  const { review, selectedRowIds, requirementService, linkService } = input;
  const source = {
    type: 'BACKLOG' as const,
    name: `Бэклог: ${input.fileName}`,
    priorityId: input.defaultPriorityId,
  };

  const { requirements } = await requirementService.list();
  const slugByTypeKey = new Map<string, string>();
  const byTypeKey = new Map<string, Requirement>();
  const takenNames = new Map<RequirementType, Set<string>>([
    ['FUNCTION', new Set()],
    ['NFR', new Set()],
  ]);
  const index = (req: Requirement): void => {
    const key = `${req.type}:${normalizeRequirementName(req.name)}`;
    slugByTypeKey.set(key, req.slug);
    byTypeKey.set(key, req);
    takenNames.get(req.type)!.add(normalizeRequirementName(req.name));
  };
  for (const req of requirements) index(req);

  const selected = review.mappings.filter((m) => selectedRowIds.has(m.rowId));
  const creatable = selected.filter((m) => m.duplicateOf === undefined);
  const duplicatesSkipped = selected.length - creatable.length;
  for (const dup of selected.filter((m) => m.duplicateOf !== undefined)) {
    rt.log('info', `Строка ${dup.rowId}: пропущена как дубль «${dup.duplicateOf!}».`);
  }

  const created: CreatedCounters = { functions: 0, nfrs: 0, links: 0, newNodes: 0 };

  /** Deterministic « (N)» suffix around FOREIGN name collisions (П4.1). */
  const freeName = (type: RequirementType, base: string, description?: string): string | null => {
    const taken = takenNames.get(type)!;
    let candidate = base;
    for (let i = 2; i <= 50; i++) {
      const key = `${type}:${normalizeRequirementName(candidate)}`;
      const existing = byTypeKey.get(key);
      if (!existing) return candidate;
      // Re-run recognition: the same import already created exactly this item.
      if (description !== undefined && (existing.description ?? '') === description) return null;
      if (description === undefined) return null; // nodes: same-name node is reused
      candidate = `${base} (${i})`;
      if (!taken.has(normalizeRequirementName(candidate))) return candidate;
    }
    return `${base} (${Date.now()})`;
  };

  const createOne = async (
    type: RequirementType,
    name: string,
    target: { quarter: TargetQuarter; year: number },
    description?: string,
  ): Promise<Requirement> => {
    const req = await requirementService.create({
      type,
      name,
      criticality: AI_IMPORT_DEFAULT_CRITICALITY,
      ...(description !== undefined ? { description } : {}),
      implemented: false,
      targetQuarter: target.quarter,
      targetYear: target.year,
      sources: [source],
    });
    index(req);
    // Mirror into the shared job counters («что уже создано» on fail/cancel).
    if (type === 'FUNCTION') rt.counters.createdFunctions += 1;
    else rt.counters.createdNfrs += 1;
    return req;
  };

  const linkChildOf = async (
    sourceSlug: string,
    targetSlug: string,
    label: string,
  ): Promise<void> => {
    try {
      await linkService.create({ sourceSlug, type: 'CHILD_OF', targetSlug });
      created.links += 1;
      rt.counters.links += 1;
    } catch (err) {
      if (err instanceof DomainError) {
        rt.log('warn', `Связь CHILD_OF ${label} не создана (${err.code}): ${err.message}`);
      } else {
        throw err;
      }
    }
  };

  // ── (1) New nodes: only the ones the SELECTED rows need (+ their ancestor
  // chain among new nodes), created in parent→child order. A node's type
  // follows its rows (NFR groups live under NFR — the CHILD_OF same-type rule).
  const nodeByKey = new Map(review.newNodes.map((n) => [normalizeRequirementName(n.name), n]));
  const nodeType = new Map<string, RequirementType>();
  const needed = new Set<string>();
  for (const mapping of creatable) {
    if (mapping.parent.kind !== 'new') continue;
    let key: string | undefined = normalizeRequirementName(mapping.parent.name);
    if (!nodeType.has(key)) nodeType.set(key, mapping.type);
    // Walk the ancestor chain through other NEW nodes.
    for (let depth = 0; key !== undefined && depth < 20; depth++) {
      if (needed.has(key)) break;
      needed.add(key);
      const node = nodeByKey.get(key);
      const parentKey =
        node?.parentName != null ? normalizeRequirementName(node.parentName) : undefined;
      if (parentKey !== undefined && nodeByKey.has(parentKey)) {
        if (!nodeType.has(parentKey)) nodeType.set(parentKey, nodeType.get(key)!);
        key = parentKey;
      } else {
        key = undefined;
      }
    }
  }

  const nodeSlugByKey = new Map<string, string>();
  const pendingNodes = new Set(needed);
  while (pendingNodes.size > 0) {
    if (rt.cancelled()) return { ok: false };
    let progressed = false;
    for (const key of [...pendingNodes]) {
      const node = nodeByKey.get(key) ?? { name: key, parentName: null, rowCount: 0 };
      const type = nodeType.get(key) ?? 'FUNCTION';
      const parentKey =
        node.parentName != null ? normalizeRequirementName(node.parentName) : undefined;
      const parentIsNewNode = parentKey !== undefined && needed.has(parentKey);
      if (parentIsNewNode && !nodeSlugByKey.has(parentKey)) continue; // parent first
      pendingNodes.delete(key);
      progressed = true;

      const existingKey = `${type}:${key}`;
      const reused = slugByTypeKey.get(existingKey);
      let slug: string;
      if (reused !== undefined) {
        rt.log('info', `Узел «${node.name}» (${type}) уже существует — переиспользован.`);
        slug = reused;
      } else {
        const req = await createOne(type, node.name, input.nodeTarget);
        created.newNodes += 1;
        rt.log('info', `Создан новый узел «${req.name}» (${type}).`);
        slug = req.slug;
        const parentSlug = parentIsNewNode
          ? nodeSlugByKey.get(parentKey)
          : parentKey !== undefined
            ? slugByTypeKey.get(`${type}:${parentKey}`)
            : undefined;
        if (parentSlug !== undefined) {
          await linkChildOf(slug, parentSlug, `«${node.name}» → «${node.parentName ?? ''}»`);
        }
      }
      nodeSlugByKey.set(key, slug);
    }
    if (!progressed) {
      // Defensive: a parent cycle among new nodes — create the rest as roots.
      for (const key of pendingNodes) {
        const node = nodeByKey.get(key) ?? { name: key, parentName: null, rowCount: 0 };
        rt.log('warn', `Узел «${node.name}»: цикл родителей — создан корневым.`);
        const req = await createOne(nodeType.get(key) ?? 'FUNCTION', node.name, input.nodeTarget);
        created.newNodes += 1;
        nodeSlugByKey.set(key, req.slug);
      }
      pendingNodes.clear();
    }
  }

  // ── (2)+(3)+(4) Requirements of the selected rows with links and sources.
  let processed = 0;
  for (const mapping of creatable) {
    if (rt.cancelled()) return { ok: false };
    const description =
      mapping.key !== undefined
        ? `${mapping.sourceText}\n\nКлюч бэклога: ${mapping.key}`
        : mapping.sourceText;
    const name = freeName(mapping.type, mapping.businessName, description);
    if (name === null) {
      rt.log(
        'warn',
        `«${mapping.businessName}» (${mapping.type}) уже создано этим импортом — пропущено (повторный запуск).`,
      );
    } else {
      if (name !== mapping.businessName) {
        rt.log('warn', `Имя «${mapping.businessName}» занято — создано как «${name}».`);
      }
      const req = await createOne(
        mapping.type,
        name,
        { quarter: mapping.targetQuarter, year: mapping.targetYear },
        description,
      );
      if (mapping.type === 'FUNCTION') created.functions += 1;
      else created.nfrs += 1;

      const parentKey = normalizeRequirementName(mapping.parent.name);
      const parentSlug =
        mapping.parent.kind === 'new'
          ? nodeSlugByKey.get(parentKey)
          : slugByTypeKey.get(`${mapping.type}:${parentKey}`);
      if (parentSlug !== undefined) {
        await linkChildOf(req.slug, parentSlug, `«${req.name}» → «${mapping.parent.name}»`);
      } else {
        rt.log(
          'warn',
          `Строка ${mapping.rowId}: родитель «${mapping.parent.name}» недоступен — требование создано корневым.`,
        );
      }
    }

    processed += 1;
    job.progress = Math.min(99, 85 + Math.round((14 * processed) / Math.max(1, creatable.length)));
    if (processed % 20 === 0 || processed === creatable.length) {
      rt.checkpoint((state) => {
        if (state.backlog) {
          const applied = new Set(state.backlog.appliedRowIds ?? []);
          for (const m of creatable.slice(0, processed)) applied.add(m.rowId);
          state.backlog.appliedRowIds = [...applied];
        }
      });
    }
  }

  const report: AiBacklogReport = {
    rowsTotal: review.mappings.length,
    rowsSelected: selected.length,
    created,
    duplicatesSkipped,
    deselected: review.mappings.length - selected.length,
    usage: { ...input.usage },
  };
  return { ok: true, report };
}
