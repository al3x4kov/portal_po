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
    }
  | { kind: 'link'; source: Requirement }
  | { kind: 'delete'; requirement: Requirement }
  | null;

export type Theme = 'light' | 'dark';

/** "Раскрыть все" (default) vs "Скрыть зависимости" (B1). */
export type TreeMode = 'expand-all' | 'collapse';

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  /** Tree display mode (B1, T-1101). */
  treeMode: TreeMode;
  setTreeMode: (m: TreeMode) => void;

  /** Branches manually expanded while in collapse mode (FR-7). */
  expanded: Set<string>;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  setExpanded: (ids: Iterable<string>) => void;

  /** Name search query (B3, T-1103). */
  search: string;
  setSearch: (q: string) => void;

  /** Applied criticality filter; empty = show all (B5, T-1105). */
  criticalityFilter: Set<Criticality>;
  setCriticalityFilter: (crits: Iterable<Criticality>) => void;

  /** Applied implementation-status filter; empty = show all (T1, E15). */
  implementationFilter: Set<ImplStatus>;
  setImplementationFilter: (statuses: Iterable<ImplStatus>) => void;

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

  treeMode: 'expand-all',
  setTreeMode: (treeMode) => set({ treeMode }),

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

  search: '',
  setSearch: (search) => set({ search }),

  criticalityFilter: new Set<Criticality>(),
  setCriticalityFilter: (crits) => set({ criticalityFilter: new Set(crits) }),

  implementationFilter: new Set<ImplStatus>(),
  setImplementationFilter: (statuses) => set({ implementationFilter: new Set(statuses) }),

  modal: null,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
}));
