import {
  AI_IMPORT_PO_GROUP_NAME_MAX,
  AI_IMPORT_PO_MAX_CHILDREN,
  AI_IMPORT_PO_MAX_ROOTS,
  breakParentCycles,
  nameKey,
  sanitizeAiName,
  sanitizeAiParentName,
  type AiExtractedRequirement,
  type AiPoAssignment,
  type AiStructureNode,
  type RequirementType,
} from '@po/core';

/**
 * Логическое дерево «навык AI Product Owner» — чистая часть (без I/O и AI).
 *
 * Модель-«PO» по батчам имён проектирует таксономию бизнес-доменов (map-reduce:
 * каждый раунд видит текущую таксономию и расширяет её), затем раскладывает
 * требования по узлам. Этот модуль владеет слиянием ответов раундов в одну
 * согласованную 2-уровневую таксономию, стабильными id узлов («F1», «F1.2»,
 * «N3»), превращением узлов в синтетические group-записи для populate и
 * резолвом назначений — всё детерминированно и покрывается unit-тестами
 * без запуска конвейера.
 */

/** One group node of the merged taxonomy. `parentKey` — nameKey of the root domain. */
export interface PoTaxonomyNode {
  type: RequirementType;
  name: string;
  /** nameKey(type, root-domain name); null for root domains. */
  parentKey: string | null;
}

/** Node with its assigned short id («F1», «F1.2», «N3»…). */
export interface PoTaxonomyNodeWithId extends PoTaxonomyNode {
  id: string;
}

/** Mutable merge accumulator across taxonomy rounds (insertion order preserved). */
export interface PoTaxonomy {
  /** nameKey(type, name) → node. */
  nodes: Map<string, PoTaxonomyNode>;
}

export function emptyTaxonomy(): PoTaxonomy {
  return { nodes: new Map() };
}

/** Structural events of one merge round — data only, RU wording lives in the stage. */
export interface PoMergeStats {
  added: number;
  /** New root domains skipped over {@link AI_IMPORT_PO_MAX_ROOTS}. */
  rootsCapped: number;
  /** New subgroups skipped over {@link AI_IMPORT_PO_MAX_CHILDREN} per root. */
  childrenCapped: number;
  /** Nodes proposed deeper than 2 levels — re-rooted under the root domain. */
  depthFlattened: number;
  /** Names truncated to {@link AI_IMPORT_PO_GROUP_NAME_MAX}. */
  namesTruncated: number;
  /** Узлы, отброшенные из-за мусорного имени («null», хвост JSON). */
  namesRejected: number;
}

/**
 * Normalize one proposed group name; мусор → null (узел пропускается).
 *
 * Модель порой присылает вместо имени строку `"null"` или имя с приклеенным
 * хвостом собственного ответа («Домен → null}, {»). Такие значения проходят
 * Zod (непустая строка ≤ 200), поэтому чистим их здесь — иначе в дереве
 * появляются группы с именем «null».
 */
function normalizeName(raw: string, stats: PoMergeStats): string | null {
  const cleaned = sanitizeAiName(raw);
  if (cleaned === null) {
    stats.namesRejected += 1;
    return null;
  }
  let name = cleaned;
  if (name.length > AI_IMPORT_PO_GROUP_NAME_MAX) {
    name = `${name.slice(0, AI_IMPORT_PO_GROUP_NAME_MAX - 1).trimEnd()}…`;
    stats.namesTruncated += 1;
  }
  return name;
}

/**
 * Merge one round's answer into the taxonomy. Rules (mirroring the legacy
 * structure-stage conflict policy — the FIRST answer wins):
 *
 * - depth is clamped to 2: a parent that is itself a child re-roots the node
 *   under the parent's root domain;
 * - an unknown parent is implicitly created as a root domain (respecting the
 *   root cap) — rounds may mention a domain before defining it;
 * - caps: at most {@link AI_IMPORT_PO_MAX_ROOTS} roots per type and
 *   {@link AI_IMPORT_PO_MAX_CHILDREN} children per root; excess proposals are
 *   skipped (the model sees the current taxonomy each round and is told to
 *   reuse it, so later rounds converge instead of growing без границ);
 * - an existing node is never re-parented (first answer wins).
 */
export function mergeTaxonomyRound(taxonomy: PoTaxonomy, answer: AiStructureNode[]): PoMergeStats {
  const stats: PoMergeStats = {
    added: 0,
    rootsCapped: 0,
    childrenCapped: 0,
    depthFlattened: 0,
    namesTruncated: 0,
    namesRejected: 0,
  };
  const { nodes } = taxonomy;

  const rootCount = (type: RequirementType): number => {
    let count = 0;
    for (const node of nodes.values()) if (node.type === type && node.parentKey === null) count++;
    return count;
  };
  const childCount = (parentKey: string): number => {
    let count = 0;
    for (const node of nodes.values()) if (node.parentKey === parentKey) count++;
    return count;
  };
  /** Insert a root domain honouring the cap; true when present afterwards. */
  const ensureRoot = (type: RequirementType, name: string): boolean => {
    const key = nameKey(type, name);
    const existing = nodes.get(key);
    if (existing) return true; // существующий узел (даже подгруппа) годится в родители
    if (rootCount(type) >= AI_IMPORT_PO_MAX_ROOTS) {
      stats.rootsCapped += 1;
      return false;
    }
    nodes.set(key, { type, name, parentKey: null });
    stats.added += 1;
    return true;
  };

  for (const raw of answer) {
    const name = normalizeName(raw.name, stats);
    if (name === null) continue;
    const key = nameKey(raw.type, name);
    // Строковый «null» в parentName означает «родителя нет» — иначе в дереве
    // появлялся бы корневой домен с именем «null».
    const rawParent = sanitizeAiParentName(raw.parentName);
    const parentName = rawParent === null ? null : normalizeName(rawParent, stats);
    if (nodes.has(key)) continue; // first answer wins — never re-parented

    if (parentName === null || nameKey(raw.type, parentName) === key) {
      ensureRoot(raw.type, name);
      continue;
    }
    if (!ensureRoot(raw.type, parentName)) continue; // родитель не поместился в кап корней
    let parentKey = nameKey(raw.type, parentName);
    const parent = nodes.get(parentKey)!;
    if (parent.parentKey !== null) {
      // Глубже 2 уровней: перевешиваем под корневой домен родителя.
      parentKey = parent.parentKey;
      stats.depthFlattened += 1;
    }
    if (childCount(parentKey) >= AI_IMPORT_PO_MAX_CHILDREN) {
      stats.childrenCapped += 1;
      continue;
    }
    nodes.set(key, { type: raw.type, name, parentKey });
    stats.added += 1;
  }

  // Пояс безопасности: цикл возможен только при будущих правках выше, но
  // разорвать его здесь дешевле, чем ловить на этапе aggregate.
  const parentByChild = new Map<string, string>();
  for (const [key, node] of nodes) if (node.parentKey) parentByChild.set(key, node.parentKey);
  for (const childKey of breakParentCycles(parentByChild)) {
    const node = nodes.get(childKey);
    if (node) nodes.set(childKey, { ...node, parentKey: null });
  }
  return stats;
}

/**
 * Assign stable short ids: roots «F1»…/«N1»… in insertion order, children
 * «F1.1»… in insertion order under their root. Возвращает и плоский список
 * (для промпта назначения), и индекс id → узел (для резолва ответов).
 */
export function assignTaxonomyIds(taxonomy: PoTaxonomy): {
  list: PoTaxonomyNodeWithId[];
  byId: Map<string, PoTaxonomyNodeWithId>;
} {
  const list: PoTaxonomyNodeWithId[] = [];
  const byId = new Map<string, PoTaxonomyNodeWithId>();
  const idByKey = new Map<string, string>();
  const rootSeq: Record<RequirementType, number> = { FUNCTION: 0, NFR: 0 };
  const childSeq = new Map<string, number>();

  const push = (key: string, node: PoTaxonomyNode, id: string): void => {
    const withId: PoTaxonomyNodeWithId = { ...node, id };
    list.push(withId);
    byId.set(id, withId);
    idByKey.set(key, id);
  };
  // Roots first (insertion order), then children grouped под своим корнем.
  for (const [key, node] of taxonomy.nodes) {
    if (node.parentKey !== null) continue;
    rootSeq[node.type] += 1;
    push(key, node, `${node.type === 'FUNCTION' ? 'F' : 'N'}${rootSeq[node.type]}`);
  }
  for (const [key, node] of taxonomy.nodes) {
    if (node.parentKey === null) continue;
    const rootId = idByKey.get(node.parentKey);
    if (!rootId) continue; // осиротевший узел (корень не создался) — не получает id
    const seq = (childSeq.get(rootId) ?? 0) + 1;
    childSeq.set(rootId, seq);
    push(key, node, `${rootId}.${seq}`);
  }
  return { list, byId };
}

/** Fixed provenance/description of synthetic group records (business field `source` stays empty at populate). */
export const PO_GROUP_SOURCE = 'AI PO: логическое дерево';
export const PO_GROUP_DESCRIPTION =
  'Группирующий раздел логического дерева требований (создан навыком AI Product Owner).';

export interface PoTreeMaterialization {
  /** Synthetic records to prepend to the extracted set (populate creates them). */
  groups: AiExtractedRequirement[];
  /** nameKey → parent NAME (или явный null для корней) — контракт aggregate. */
  parentNameByKey: Map<string, string | null>;
  /** Имена узлов, совпавших с извлечёнными требованиями (группа не создаётся). */
  collisions: string[];
}

/**
 * Turn the taxonomy into populate-ready material: synthetic group records for
 * nodes that do NOT collide with an extracted requirement (a collision means
 * the extracted requirement itself becomes the group node), plus the
 * taxonomy's own parent mapping (subgroup → root domain, roots → null).
 */
export function materializeTaxonomy(
  taxonomy: PoTaxonomy,
  extractedKeys: ReadonlySet<string>,
): PoTreeMaterialization {
  const groups: AiExtractedRequirement[] = [];
  const parentNameByKey = new Map<string, string | null>();
  const collisions: string[] = [];
  for (const [key, node] of taxonomy.nodes) {
    const parentName = node.parentKey ? (taxonomy.nodes.get(node.parentKey)?.name ?? null) : null;
    parentNameByKey.set(key, parentName);
    if (extractedKeys.has(key)) {
      collisions.push(node.name);
      continue;
    }
    groups.push({
      type: node.type,
      name: node.name,
      description: PO_GROUP_DESCRIPTION,
      source: PO_GROUP_SOURCE,
    });
  }
  return { groups, parentNameByKey, collisions };
}

/** Counters of one assignment-batch resolution (RU wording lives in the stage). */
export interface PoAssignStats {
  assigned: number;
  /** Explicit `node: null` answers — требование остаётся корневым. */
  explicitRoots: number;
  /** Ответы про требования не из этого батча. */
  foreign: number;
  /** Неизвестный id узла таксономии. */
  unknownNode: number;
  /** Узел другого типа (ФТ в N-узел и наоборот). */
  typeMismatch: number;
}

/**
 * Resolve one assignment batch into the shared parent map. First answer wins;
 * ключи, уже занятые таксономией (требование-«группа»), не перезаписываются.
 */
export function resolveAssignments(
  assignments: AiPoAssignment[],
  byId: ReadonlyMap<string, PoTaxonomyNodeWithId>,
  batchKeys: ReadonlySet<string>,
  parentNameByKey: Map<string, string | null>,
): PoAssignStats {
  const stats: PoAssignStats = {
    assigned: 0,
    explicitRoots: 0,
    foreign: 0,
    unknownNode: 0,
    typeMismatch: 0,
  };
  for (const answer of assignments) {
    const key = nameKey(answer.type, answer.name);
    if (!batchKeys.has(key)) {
      stats.foreign += 1;
      continue;
    }
    if (parentNameByKey.has(key)) continue; // группа или уже отвеченное — первый ответ победил
    if (answer.node === null) {
      parentNameByKey.set(key, null);
      stats.explicitRoots += 1;
      continue;
    }
    const node = byId.get(answer.node.trim().toUpperCase());
    if (!node) {
      stats.unknownNode += 1;
      continue;
    }
    if (node.type !== answer.type) {
      stats.typeMismatch += 1;
      continue;
    }
    parentNameByKey.set(key, node.name);
    stats.assigned += 1;
  }
  return stats;
}
