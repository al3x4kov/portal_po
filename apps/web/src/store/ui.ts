import { create } from 'zustand';
import type { Requirement, RequirementType } from '@po/core';

export type ModalState =
  | { kind: 'requirement'; reqType: RequirementType; requirement?: Requirement }
  | { kind: 'link'; source: Requirement }
  | { kind: 'delete'; requirement: Requirement }
  | null;

export type Theme = 'light' | 'dark';

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  /** Expanded tree node ids (UI-only state, FR-7). */
  expanded: Set<string>;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  setExpanded: (ids: Iterable<string>) => void;

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

  modal: null,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
}));
