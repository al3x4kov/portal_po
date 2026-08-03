import type { Criticality, Requirement } from '@po/core';
import type { TreeNode } from './tree';
import { sourceNamesOf } from './sources';

/**
 * A row is a `match` when it satisfies the active filters on its own merit, or
 * a `context` ancestor kept only so a deeper match never becomes an orphan.
 */
export type RowKind = 'match' | 'context';

export interface VisibleRow {
  requirement: Requirement;
  depth: number;
  kind: RowKind;
  /** The node has children in the full forest. */
  hasChildren: boolean;
  /**
   * In "Скрыть зависимости" mode: number of descendants currently hidden under
   * this (collapsed) node — drives the "N зависимостей" chip. 0 otherwise.
   */
  hiddenCount: number;
}

/**
 * The single source of truth for which tree rows are visible. Search (B3),
 * the collapse toggle (B1) and the criticality filter (B5) are NOT independent
 * mechanisms — they all feed this one pure function (PLAN A6#4).
 *
 * Rules:
 *  - A row is visible if it passes the active filters itself (`match`) OR is an
 *    ancestor of a visible descendant (`context`) — the tree stays connected.
 *  - When any filter (search/criticality) is active, matches are revealed with
 *    their ancestors regardless of the collapse toggle (интерсекция → предки).
 *  - With no active filter, the collapse toggle governs expansion; a collapsed
 *    node exposes `hiddenCount` for its chip.
 */
export interface VisibilityInput {
  forest: TreeNode[];
  search: string;
  collapsed: boolean;
  /** Branches manually expanded while in collapse mode. */
  expanded: ReadonlySet<string>;
  /**
   * Branches manually collapsed while in expand-all mode (task23): point
   * exceptions to «всё развёрнуто». Ignored in collapse mode and while any
   * filter is active (search still force-reveals matches with ancestors).
   */
  collapsedOverrides?: ReadonlySet<string>;
  /** Selected criticalities; empty set = no criticality filter. */
  criticalityFilter: ReadonlySet<Criticality>;
  /**
   * Selected implementation statuses; empty set = no implementation filter (T1).
   * `DONE` = implemented === true, `PLANNED` = implemented === false.
   */
  implementationFilter?: ReadonlySet<'DONE' | 'PLANNED'>;
  /**
   * Selected source values; empty set = no source filter (FR-19).
   * A requirement matches when ANY of its `sources[]` names (or its legacy
   * scalar `source`) is selected. Empty string '' matches requirements with no
   * source at all («Не задан»). See {@link sourceNamesOf} (todo_19).
   */
  sourceFilter?: ReadonlySet<string>;
}

export interface VisibilityResult {
  rows: VisibleRow[];
  /** Rows that matched on their own merit. */
  matchCount: number;
  /** Ancestor-only context rows. */
  contextCount: number;
  /** Total requirements in the forest. */
  total: number;
}

const EMPTY_IMPL: ReadonlySet<'DONE' | 'PLANNED'> = new Set();
const EMPTY_SOURCE: ReadonlySet<string> = new Set();
const EMPTY_OVERRIDES: ReadonlySet<string> = new Set();

function countDescendants(node: TreeNode): number {
  let n = node.children.length;
  for (const c of node.children) n += countDescendants(c);
  return n;
}

function countNodes(forest: TreeNode[]): number {
  let n = 0;
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      n += 1;
      walk(node.children);
    }
  };
  walk(forest);
  return n;
}

export function computeVisibleRows(input: VisibilityInput): VisibilityResult {
  const { forest, search, collapsed, expanded, criticalityFilter } = input;
  const implementationFilter = input.implementationFilter ?? EMPTY_IMPL;
  const sourceFilter = input.sourceFilter ?? EMPTY_SOURCE;
  const query = search.trim().toLowerCase();
  const searchActive = query.length > 0;
  const critActive = criticalityFilter.size > 0;
  const implActive = implementationFilter.size > 0;
  const srcActive = sourceFilter.size > 0;
  const filterActive = searchActive || critActive || implActive || srcActive;
  const total = countNodes(forest);

  const matchesSelf = (req: Requirement): boolean => {
    const okSearch = !searchActive || req.name.toLowerCase().includes(query);
    const okCrit = !critActive || criticalityFilter.has(req.criticality);
    const okImpl = !implActive || implementationFilter.has(req.implemented ? 'DONE' : 'PLANNED');
    const okSource = !srcActive || matchesSource(req);
    return okSearch && okCrit && okImpl && okSource; // intersection (AND) of the active predicates
  };

  const matchesSource = (req: Requirement): boolean => {
    const names = sourceNamesOf(req);
    // No source at all → matches the «Не задан» option ('').
    if (names.length === 0) return sourceFilter.has('');
    // Otherwise ANY of the requirement's source names must be selected (union).
    return names.some((name) => sourceFilter.has(name));
  };

  const rows: VisibleRow[] = [];
  let matchCount = 0;
  let contextCount = 0;

  if (filterActive) {
    // Pass 1: mark every node that is a match or an ancestor of a match.
    const kindOf = new Map<string, RowKind>();
    const mark = (node: TreeNode): boolean => {
      let descendantVisible = false;
      for (const child of node.children) {
        if (mark(child)) descendantVisible = true;
      }
      if (matchesSelf(node.requirement)) {
        kindOf.set(node.requirement.slug, 'match');
        return true;
      }
      if (descendantVisible) {
        kindOf.set(node.requirement.slug, 'context');
        return true;
      }
      return false;
    };
    forest.forEach(mark);

    // Pass 2: flatten in DFS order, keeping only visible nodes (fully expanded).
    const walk = (node: TreeNode): void => {
      const kind = kindOf.get(node.requirement.slug);
      if (!kind) return;
      rows.push({
        requirement: node.requirement,
        depth: node.depth,
        kind,
        hasChildren: node.children.length > 0,
        hiddenCount: 0,
      });
      if (kind === 'match') matchCount += 1;
      else contextCount += 1;
      node.children.forEach(walk);
    };
    forest.forEach(walk);

    return { rows, matchCount, contextCount, total };
  }

  if (!collapsed) {
    // Expand all: every node visible, except branches the user collapsed
    // point-wise via the chevron (task23 — collapsedOverrides).
    const overrides = input.collapsedOverrides ?? EMPTY_OVERRIDES;
    const walk = (node: TreeNode): void => {
      const hasChildren = node.children.length > 0;
      const isCollapsed = hasChildren && overrides.has(node.requirement.slug);
      rows.push({
        requirement: node.requirement,
        depth: node.depth,
        kind: 'match',
        hasChildren,
        hiddenCount: isCollapsed ? countDescendants(node) : 0,
      });
      matchCount += 1;
      if (!isCollapsed) node.children.forEach(walk);
    };
    forest.forEach(walk);
    return { rows, matchCount, contextCount, total };
  }

  // Collapse dependencies: roots always visible; a node's children are visible
  // only when the node was manually expanded.
  const walk = (node: TreeNode): void => {
    const isExpanded = expanded.has(node.requirement.slug);
    const hasChildren = node.children.length > 0;
    rows.push({
      requirement: node.requirement,
      depth: node.depth,
      kind: 'match',
      hasChildren,
      hiddenCount: hasChildren && !isExpanded ? countDescendants(node) : 0,
    });
    matchCount += 1;
    if (hasChildren && isExpanded) node.children.forEach(walk);
  };
  forest.forEach(walk);
  return { rows, matchCount, contextCount, total };
}
