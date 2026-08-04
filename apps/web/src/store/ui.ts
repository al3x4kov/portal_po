import { create } from 'zustand';
import type { Criticality, LinkType, Requirement, RequirementType } from '@po/core';

/** Implementation status filter values (T1, E15). */
export type ImplStatus = 'DONE' | 'PLANNED';

export type ModalState =
  | {
      kind: 'requirement';
      reqType: RequirementType;
      requirement?: Requirement;
      /** T4: preset a link from this source slug once the new requirement is created. */
      linkFrom?: string;
      linkType?: LinkType;
      /** T-515: auto-focus a specific field when the modal opens. */
      focusField?: 'description';
    }
  | { kind: 'link'; source: Requirement; initialTypeFilter?: RequirementType }
  | { kind: 'delete'; requirement: Requirement }
  | { kind: 'export' }
  | { kind: 'export-tasks' }
  | null;

export type Theme = 'light' | 'dark';

/** "Раскрыть все" (default) vs "Скрыть зависимости" (B1). */
export type TreeMode = 'expand-all' | 'collapse';

/** Main-screen layout: requirements tree vs source-slice (todo_19 T-208). */
export type MainView = 'tree' | 'sources';

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  /** Graph view toggle: true = graph, false = tree (T-G108). */
  graphView: boolean;
  setGraphView: (v: boolean) => void;

  /** Tree display mode (B1, T-1101). */
  treeMode: TreeMode;
  setTreeMode: (m: TreeMode) => void;

  /** Main-screen view: hierarchical tree vs «По источникам» slice (todo_19 T-208). */
  mainView: MainView;
  setMainView: (v: MainView) => void;

  /** Branches manually expanded while in collapse mode (FR-7). */
  expanded: Set<string>;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  setExpanded: (ids: Iterable<string>) => void;

  /**
   * Branches manually collapsed while in expand-all mode (task23): point
   * exceptions to «всё развёрнуто». Cleared by «Развернуть/Свернуть все».
   */
  collapsedOverrides: Set<string>;
  toggleCollapsedOverride: (id: string) => void;

  /** Name search query (B3, T-1103). */
  search: string;
  setSearch: (q: string) => void;

  /** Applied criticality filter; empty = show all (B5, T-1105). */
  criticalityFilter: Set<Criticality>;
  setCriticalityFilter: (crits: Iterable<Criticality>) => void;

  /** Applied implementation-status filter; empty = show all (T1, E15). */
  implementationFilter: Set<ImplStatus>;
  setImplementationFilter: (statuses: Iterable<ImplStatus>) => void;

  /** Applied source filter; empty = show all (FR-19). */
  sourceFilter: Set<string>;
  setSourceFilter: (sources: Iterable<string>) => void;

  /**
   * task26: «Только непроверенные (ИИ)» — keep just the requirements an AI
   * import created and nobody confirmed yet. false = no such filter.
   */
  aiPendingFilter: boolean;
  setAiPendingFilter: (on: boolean) => void;
  toggleAiPendingFilter: () => void;

  /** Clear every applied filter at once (UX-6 "Сбросить фильтры"). */
  resetFilters: () => void;

  modal: ModalState;
  openModal: (modal: NonNullable<ModalState>) => void;
  closeModal: () => void;
}

function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage?.getItem('po-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    if (typeof window !== 'undefined') window.localStorage?.setItem('po-theme', theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  graphView: false,
  setGraphView: (graphView) => set({ graphView }),

  treeMode: 'expand-all',
  // «Развернуть все» / «Свернуть все» reset point overrides so the tree lands
  // in the clean state of the chosen mode (task23).
  setTreeMode: (treeMode) =>
    set({ treeMode, expanded: new Set<string>(), collapsedOverrides: new Set<string>() }),

  mainView: 'tree',
  setMainView: (mainView) => set({ mainView }),

  expanded: new Set<string>(),
  isExpanded: (id) => get().expanded.has(id),
  toggleExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expanded: next };
    }),
  setExpanded: (ids) => set({ expanded: new Set(ids) }),

  collapsedOverrides: new Set<string>(),
  toggleCollapsedOverride: (id) =>
    set((state) => {
      const next = new Set(state.collapsedOverrides);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedOverrides: next };
    }),

  search: '',
  setSearch: (search) => set({ search }),

  criticalityFilter: new Set<Criticality>(),
  setCriticalityFilter: (crits) => set({ criticalityFilter: new Set(crits) }),

  implementationFilter: new Set<ImplStatus>(),
  setImplementationFilter: (statuses) => set({ implementationFilter: new Set(statuses) }),

  sourceFilter: new Set<string>(),
  setSourceFilter: (sources) => set({ sourceFilter: new Set(sources) }),

  aiPendingFilter: false,
  setAiPendingFilter: (aiPendingFilter) => set({ aiPendingFilter }),
  toggleAiPendingFilter: () => set((state) => ({ aiPendingFilter: !state.aiPendingFilter })),

  resetFilters: () =>
    set({
      criticalityFilter: new Set<Criticality>(),
      implementationFilter: new Set<ImplStatus>(),
      sourceFilter: new Set<string>(),
      aiPendingFilter: false,
    }),

  modal: null,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
}));
