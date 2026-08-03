import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Criticality } from '@po/core';
import { useUiStore, type ImplStatus } from './ui';
import { makeReq } from '../test/fixtures';

const initial = useUiStore.getState();

function resetStore() {
  useUiStore.setState({
    theme: 'light',
    graphView: false,
    treeMode: 'expand-all',
    expanded: new Set<string>(),
    collapsedOverrides: new Set<string>(),
    search: '',
    criticalityFilter: new Set<Criticality>(),
    implementationFilter: new Set<ImplStatus>(),
    sourceFilter: new Set<string>(),
    modal: null,
  });
}

beforeEach(() => {
  window.localStorage?.clear();
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const s = () => useUiStore.getState();

describe('theme', () => {
  it('setTheme updates state and persists to localStorage', () => {
    s().setTheme('dark');
    expect(s().theme).toBe('dark');
    if (window.localStorage) {
      expect(window.localStorage.getItem('po-theme')).toBe('dark');
    }
  });

  it('setTheme writes to localStorage when it is available', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem, getItem: vi.fn(), clear: vi.fn() });
    try {
      s().setTheme('dark');
      expect(setItem).toHaveBeenCalledWith('po-theme', 'dark');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('toggleTheme flips light → dark → light', () => {
    s().setTheme('light');
    s().toggleTheme();
    expect(s().theme).toBe('dark');
    s().toggleTheme();
    expect(s().theme).toBe('light');
  });
});

describe('graphView & treeMode', () => {
  it('setGraphView toggles the graph flag', () => {
    s().setGraphView(true);
    expect(s().graphView).toBe(true);
    s().setGraphView(false);
    expect(s().graphView).toBe(false);
  });

  it('setTreeMode switches display mode', () => {
    s().setTreeMode('collapse');
    expect(s().treeMode).toBe('collapse');
    s().setTreeMode('expand-all');
    expect(s().treeMode).toBe('expand-all');
  });

  it('task23: setTreeMode resets point overrides of both modes to a clean state', () => {
    s().toggleCollapsedOverride('a');
    s().toggleExpanded('b');
    s().setTreeMode('collapse');
    expect(s().collapsedOverrides.size).toBe(0);
    expect(s().expanded.size).toBe(0);

    s().toggleExpanded('b');
    s().toggleCollapsedOverride('a');
    s().setTreeMode('expand-all');
    expect(s().collapsedOverrides.size).toBe(0);
    expect(s().expanded.size).toBe(0);
  });
});

describe('expanded set', () => {
  it('toggleExpanded adds then removes a slug (both branches)', () => {
    expect(s().isExpanded('a')).toBe(false);
    s().toggleExpanded('a');
    expect(s().isExpanded('a')).toBe(true);
    s().toggleExpanded('a');
    expect(s().isExpanded('a')).toBe(false);
  });

  it('toggleExpanded keeps other members when adding/removing', () => {
    s().setExpanded(['a', 'b']);
    s().toggleExpanded('c');
    expect([...s().expanded].sort()).toEqual(['a', 'b', 'c']);
    s().toggleExpanded('a');
    expect([...s().expanded].sort()).toEqual(['b', 'c']);
  });

  it('setExpanded replaces the whole set from any iterable', () => {
    s().setExpanded(['x', 'y']);
    expect(s().isExpanded('x')).toBe(true);
    s().setExpanded(new Set(['z']));
    expect(s().isExpanded('x')).toBe(false);
    expect(s().isExpanded('z')).toBe(true);
  });
});

describe('collapsedOverrides set (task23)', () => {
  it('toggleCollapsedOverride adds then removes a slug (both branches)', () => {
    expect(s().collapsedOverrides.has('a')).toBe(false);
    s().toggleCollapsedOverride('a');
    expect(s().collapsedOverrides.has('a')).toBe(true);
    s().toggleCollapsedOverride('a');
    expect(s().collapsedOverrides.has('a')).toBe(false);
  });

  it('toggleCollapsedOverride keeps other members when adding/removing', () => {
    s().toggleCollapsedOverride('a');
    s().toggleCollapsedOverride('b');
    s().toggleCollapsedOverride('c');
    expect([...s().collapsedOverrides].sort()).toEqual(['a', 'b', 'c']);
    s().toggleCollapsedOverride('a');
    expect([...s().collapsedOverrides].sort()).toEqual(['b', 'c']);
  });
});

describe('search', () => {
  it('setSearch stores the query', () => {
    s().setSearch('карта');
    expect(s().search).toBe('карта');
  });
});

describe('filters', () => {
  it('setCriticalityFilter stores a set from an iterable', () => {
    s().setCriticalityFilter(['HIGH', 'CRITICAL']);
    expect([...s().criticalityFilter].sort()).toEqual(['CRITICAL', 'HIGH']);
  });

  it('setImplementationFilter stores impl statuses', () => {
    s().setImplementationFilter(['PLANNED']);
    expect([...s().implementationFilter]).toEqual(['PLANNED']);
  });

  it('setSourceFilter stores source strings', () => {
    s().setSourceFilter(['docA', 'docB']);
    expect([...s().sourceFilter].sort()).toEqual(['docA', 'docB']);
  });

  it('resetFilters clears every applied filter', () => {
    s().setCriticalityFilter(['HIGH']);
    s().setImplementationFilter(['DONE']);
    s().setSourceFilter(['x']);
    s().resetFilters();
    expect(s().criticalityFilter.size).toBe(0);
    expect(s().implementationFilter.size).toBe(0);
    expect(s().sourceFilter.size).toBe(0);
  });
});

describe('modal', () => {
  it('openModal sets the modal state and closeModal clears it', () => {
    const source = makeReq({ slug: 'a', name: 'A' });
    s().openModal({ kind: 'link', source });
    expect(s().modal).toEqual({ kind: 'link', source });
    s().closeModal();
    expect(s().modal).toBeNull();
  });

  it('openModal supports a requirement modal payload', () => {
    s().openModal({ kind: 'requirement', reqType: 'FUNCTION' });
    expect(s().modal).toMatchObject({ kind: 'requirement', reqType: 'FUNCTION' });
  });
});

describe('initialTheme (module init)', () => {
  it('was resolved to a valid theme on first import', () => {
    expect(['light', 'dark']).toContain(initial.theme);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reads a stored theme from localStorage when present', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'po-theme' ? 'dark' : null),
      setItem: vi.fn(),
    });
    vi.resetModules();
    const mod = await import('./ui');
    expect(mod.useUiStore.getState().theme).toBe('dark');
  });

  it('falls back to the OS colour scheme when nothing is stored (dark)', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    vi.resetModules();
    const mod = await import('./ui');
    expect(mod.useUiStore.getState().theme).toBe('dark');
  });

  it('falls back to light when the OS does not prefer dark', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    vi.resetModules();
    const mod = await import('./ui');
    expect(mod.useUiStore.getState().theme).toBe('light');
  });
});
