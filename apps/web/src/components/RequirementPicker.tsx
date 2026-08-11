import { useMemo, useState } from 'react';
import { Search, TriangleAlert } from 'lucide-react';
import type { Criticality, Requirement } from '@po/core';
import { CRITICALITIES } from '@po/core';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { plural } from '../lib/plural';
import { CriticalityBadge } from './badges';
import { buildForest, type TreeNode } from '../lib/tree';
import { buildLineGuides } from '../lib/treeLines';
import type { VisibleRow } from '../lib/visibility';
import { sourceNamesOf } from '../lib/sources';

/** Состояние чекбокса строки с учётом всей её ветки. */
type BranchState = 'on' | 'off' | 'partial';

export interface RequirementPickerProps {
  requirements: Requirement[];
  /** Выбранные slug'и — состояние живёт у экрана-владельца (панель-итог справа). */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  testid?: string;
}

function flattenTree(
  nodes: TreeNode[],
  depth = 0,
): Array<{ req: Requirement; depth: number; hasChildren: boolean }> {
  const result: Array<{ req: Requirement; depth: number; hasChildren: boolean }> = [];
  for (const node of nodes) {
    result.push({ req: node.requirement, depth, hasChildren: node.children.length > 0 });
    result.push(...flattenTree(node.children, depth + 1));
  }
  return result;
}

/** «N требований скрыто фильтрами» with correct declension. */
export function hiddenLabel(n: number): string {
  return `${n} ${plural(n, 'требование скрыто', 'требования скрыты', 'требований скрыто')} фильтрами`;
}

/** Срок реализации строкой: «Q3 2026» или «—» у реализованных/бессрочных. */
function termLabel(r: Requirement): string {
  if (r.implemented || !r.targetQuarter) return '—';
  return `${r.targetQuarter} ${r.targetYear ?? ''}`.trim();
}

/** Строка требования: чекбокс ветки + тип + имя + критичность + срок. */
function PickerRow({
  req,
  guides,
  hasChildren,
  state,
  onToggle,
}: {
  req: Requirement;
  guides?: string[];
  hasChildren: boolean;
  state: BranchState;
  onToggle: (slug: string) => void;
}): React.ReactElement {
  return (
    <label
      className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
      style={{ borderTop: '1px solid var(--color-border)' }}
      data-testid={`export-item-${req.slug}`}
      data-select-state={state}
    >
      {(guides ?? []).map((guide, k) => (
        <span
          key={k}
          className={`tree-guide tree-guide--${guide}`}
          aria-hidden="true"
          style={{ flexShrink: 0, width: '16px', alignSelf: 'stretch', position: 'relative' }}
        />
      ))}
      <span className="flex-none text-xs" style={{ color: 'var(--color-text-3)' }} aria-hidden>
        {hasChildren ? '▾' : '•'}
      </span>
      <input
        type="checkbox"
        className="flex-none"
        checked={state === 'on'}
        ref={(el) => {
          if (el) el.indeterminate = state === 'partial';
        }}
        aria-label={hasChildren ? `${req.name} — выбрать ветку` : req.name}
        onChange={() => onToggle(req.slug)}
      />
      <span
        className="flex-none rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        style={
          req.type === 'FUNCTION'
            ? { background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }
            : { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }
        }
      >
        {req.type === 'FUNCTION' ? 'ФТ' : 'НФТ'}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{req.name}</span>
      <span className="flex-none">
        <CriticalityBadge criticality={req.criticality} />
      </span>
      <span
        className="w-[68px] flex-none text-right text-xs"
        style={{ color: 'var(--color-text-3)' }}
        data-testid={`picker-term-${req.slug}`}
      >
        {termLabel(req)}
      </span>
    </label>
  );
}

/**
 * Панель выбора требований деревом с чекбоксами (макеты Э1/Г2).
 *
 * Компонент контролируемый: выбор хранит экран-владелец, потому что рядом живёт
 * панель-итог (состав экспорта / итог задач), которая должна пересчитываться на
 * лету. Чекбокс родителя работает на ВСЮ ветку (включая потомков, скрытых
 * фильтром) и показывает частичный выбор — «выбор целыми ветками» из макета.
 */
export function RequirementPicker({
  requirements,
  selected,
  onChange,
  testid,
}: RequirementPickerProps): React.ReactElement {
  // §2.12.3: name search lives ABOVE the chip filters.
  const [search, setSearch] = useState('');
  const [critFilter, setCritFilter] = useState<Set<Criticality>>(new Set());
  const [implFilter, setImplFilter] = useState<'all' | 'planned' | 'done'>('all');
  const [quarterFilter, setQuarterFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());

  const availableQuarters = useMemo(() => {
    const pairs = new Set<string>();
    for (const r of requirements) {
      if (!r.implemented && r.targetQuarter && r.targetYear) {
        pairs.add(`${r.targetQuarter}-${r.targetYear}`);
      }
    }
    return [...pairs].sort();
  }, [requirements]);

  // Sources are matched case-insensitively: values differing only by case
  // (e.g. «АС21» / «ас21») collapse into one. `key` is the normalized
  // (trimmed, lowercased) value used for filtering; `label` is the canonical
  // display — the first original spelling seen. Empty source → «Не задан».
  const availableSources = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of requirements) {
      // todo_19: names from sources[], falling back to the legacy scalar source.
      const names = sourceNamesOf(r);
      if (names.length === 0) {
        if (!map.has('')) map.set('', '');
        continue;
      }
      for (const name of names) {
        const key = name.trim().toLowerCase();
        if (!map.has(key)) map.set(key, name.trim());
      }
    }
    return [...map.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => {
        if (a.key === '') return 1; // «Не задан» — в конец
        if (b.key === '') return -1;
        return a.label.localeCompare(b.label);
      });
  }, [requirements]);

  /** Потомки по PARENT_OF над ПОЛНЫМ набором — выбор ветки не зависит от фильтра. */
  const descendantsOf = useMemo(() => {
    const bySlug = new Map(requirements.map((r) => [r.slug, r]));
    const cache = new Map<string, string[]>();
    const collect = (slug: string, seen: Set<string>): string[] => {
      const cached = cache.get(slug);
      if (cached) return cached;
      const req = bySlug.get(slug);
      const out: string[] = [];
      if (req) {
        for (const l of req.links) {
          if (l.type !== 'PARENT_OF' || seen.has(l.targetSlug)) continue;
          seen.add(l.targetSlug);
          out.push(l.targetSlug, ...collect(l.targetSlug, seen));
        }
      }
      cache.set(slug, out);
      return out;
    };
    return (slug: string): string[] => collect(slug, new Set([slug]));
  }, [requirements]);

  const functional = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION'),
    [requirements],
  );
  const nfr = useMemo(() => requirements.filter((r) => r.type === 'NFR'), [requirements]);

  const query = search.trim().toLowerCase();

  function passesFilters(r: Requirement): boolean {
    if (query.length > 0 && !r.name.toLowerCase().includes(query)) return false;
    if (critFilter.size > 0 && !critFilter.has(r.criticality)) return false;
    if (implFilter === 'planned' && r.implemented) return false;
    if (implFilter === 'done' && !r.implemented) return false;
    if (
      quarterFilter.size > 0 &&
      (!r.targetQuarter ||
        !r.targetYear ||
        !quarterFilter.has(`${r.targetQuarter}-${r.targetYear}`))
    )
      return false;
    if (sourceFilter.size > 0) {
      // todo_19: match ANY of the requirement's source names (case-insensitive),
      // or the «Не задан» key '' when it has no source at all.
      const names = sourceNamesOf(r);
      const keys = names.length === 0 ? [''] : names.map((n) => n.trim().toLowerCase());
      if (!keys.some((k) => sourceFilter.has(k))) return false;
    }
    return true;
  }

  const filteredFunctional = useMemo(
    () => functional.filter(passesFilters),
    [functional, query, critFilter, implFilter, quarterFilter, sourceFilter], // passesFilters is stable w.r.t. these deps
  );

  const fnFlat = useMemo(() => {
    const forest = buildForest(filteredFunctional);
    return flattenTree(forest);
  }, [filteredFunctional]);

  const fnVisibleRows = useMemo(
    (): VisibleRow[] =>
      fnFlat.map(({ req, depth, hasChildren }) => ({
        requirement: req,
        depth,
        kind: 'match',
        hasChildren,
        hiddenCount: 0,
      })),
    [fnFlat],
  );

  const fnGuides = useMemo(() => buildLineGuides(fnVisibleRows), [fnVisibleRows]);

  const filteredNfr = useMemo(
    () => nfr.filter(passesFilters),
    [nfr, query, critFilter, implFilter, quarterFilter, sourceFilter], // passesFilters is stable w.r.t. these deps
  );

  const visible = useMemo(
    () => [...filteredFunctional, ...filteredNfr],
    [filteredFunctional, filteredNfr],
  );

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.slug));
  const selectedCount = selected.size;
  // §2.12.1: selected rows can be hidden by the filters — count the visible part.
  const visibleSelectedCount = useMemo(
    () => visible.filter((r) => selected.has(r.slug)).length,
    [visible, selected],
  );
  const hiddenCount = requirements.length - visible.length;
  const filtersActive =
    query.length > 0 ||
    critFilter.size > 0 ||
    implFilter !== 'all' ||
    quarterFilter.size > 0 ||
    sourceFilter.size > 0;

  function resetFilters(): void {
    setSearch('');
    setCritFilter(new Set());
    setImplFilter('all');
    setQuarterFilter(new Set());
    setSourceFilter(new Set());
  }

  function selectAllVisible(): void {
    const next = new Set(selected);
    for (const r of visible) next.add(r.slug);
    onChange(next);
  }

  function deselectAllVisible(): void {
    const next = new Set(selected);
    for (const r of visible) next.delete(r.slug);
    onChange(next);
  }

  /** Клик по строке: лист — сам себя, узел с детьми — всю ветку целиком. */
  function toggleBranch(slug: string): void {
    const branch = [slug, ...descendantsOf(slug)];
    const next = new Set(selected);
    const allOn = branch.every((s) => next.has(s));
    for (const s of branch) {
      if (allOn) next.delete(s);
      else next.add(s);
    }
    onChange(next);
  }

  function branchState(slug: string): BranchState {
    const branch = [slug, ...descendantsOf(slug)];
    const on = branch.filter((s) => selected.has(s)).length;
    if (on === 0) return 'off';
    return on === branch.length ? 'on' : 'partial';
  }

  function toggleCrit(c: Criticality): void {
    setCritFilter((s) => {
      const next = new Set(s);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function toggleQuarter(key: string): void {
    setQuarterFilter((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSource(val: string): void {
    setSourceFilter((s) => {
      const next = new Set(s);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }

  const chipStyle = (on: boolean): React.CSSProperties =>
    on
      ? {
          background: 'var(--color-primary)',
          color: '#fff',
          borderColor: 'var(--color-primary)',
        }
      : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid={testid}>
      {/* §2.12.3 · поиск по имени — над списком и фильтрами */}
      <div className="relative flex-none">
        <Search className="icon-sm t3 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
        <label className="sr-only" htmlFor="picker-search">
          Поиск требований по имени
        </label>
        <input
          id="picker-search"
          type="search"
          className="input !pl-9"
          placeholder="Поиск по имени требования…"
          data-testid="picker-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Filters — split into named groups */}
      <div
        className="flex-none space-y-3 rounded-lg p-3"
        style={{ background: 'var(--color-surface-2)' }}
        data-testid="export-filter-zone"
      >
        <div className="flex items-center justify-between">
          <p
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--color-text-3)' }}
          >
            Фильтры
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="picker-filters-reset"
            disabled={!filtersActive}
            onClick={resetFilters}
          >
            Сбросить
          </button>
        </div>

        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          {/* Group: Критичность */}
          <div className="space-y-1.5" role="group" aria-label="Критичность">
            <p
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              Критичность
            </p>
            <div className="flex flex-wrap gap-1.5">
              {CRITICALITIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                  style={chipStyle(critFilter.has(c))}
                  aria-pressed={critFilter.has(c)}
                  onClick={() => toggleCrit(c)}
                  data-testid={`export-filter-crit-${c}`}
                >
                  {CRITICALITY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Group: Реализация (implementation + quarter chips) */}
          <div className="space-y-1.5" role="group" aria-label="Реализация">
            <p
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              Реализация
            </p>
            <div className="flex gap-1.5">
              {(['all', 'done', 'planned'] as const).map((v) => {
                const labels = { all: 'Все', done: 'Реализовано', planned: 'Запланировано' };
                return (
                  <button
                    key={v}
                    type="button"
                    className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                    style={chipStyle(implFilter === v)}
                    aria-pressed={implFilter === v}
                    onClick={() => {
                      setImplFilter(v);
                      setQuarterFilter(new Set());
                    }}
                    data-testid={`export-filter-impl-${v}`}
                  >
                    {labels[v]}
                  </button>
                );
              })}
            </div>
            {/* Quarter chips — only when 'planned' */}
            {implFilter === 'planned' && availableQuarters.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {availableQuarters.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="rounded-full border px-2.5 py-1 text-xs font-medium"
                    style={chipStyle(quarterFilter.has(key))}
                    aria-pressed={quarterFilter.has(key)}
                    onClick={() => toggleQuarter(key)}
                    data-testid={`export-filter-q-${key}`}
                  >
                    {key.replace('-', ' ')}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Group: Источник — only when there are 2+ distinct (normalized) values */}
          {availableSources.length > 1 ? (
            <div className="space-y-1.5" role="group" aria-label="Источник">
              <p
                className="text-xs font-semibold uppercase tracking-wide"
                style={{ color: 'var(--color-text-3)' }}
              >
                Источник
              </p>
              <div className="flex flex-wrap gap-1.5">
                {availableSources.map(({ key, label }) => (
                  <button
                    key={key === '' ? '__empty__' : key}
                    type="button"
                    className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                    style={chipStyle(sourceFilter.has(key))}
                    aria-pressed={sourceFilter.has(key)}
                    onClick={() => toggleSource(key)}
                    data-testid={`export-filter-src-${key === '' ? 'empty' : label}`}
                  >
                    {key === '' ? 'Не задан' : label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Group: Выбор — select all / deselect + двухчастный счётчик (§2.12.1) */}
      <div
        className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5"
        role="group"
        aria-label="Выбор"
      >
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          Выбрать:
        </span>
        <button
          type="button"
          className="text-xs font-semibold underline underline-offset-2"
          style={{ color: 'var(--color-primary)' }}
          onClick={selectAllVisible}
          data-testid="export-toggle-all"
          disabled={allVisibleSelected}
        >
          Выбрать все
        </button>
        <button
          type="button"
          className="text-xs font-semibold underline underline-offset-2"
          style={{ color: 'var(--color-primary)' }}
          onClick={deselectAllVisible}
          data-testid="export-untoggle-all"
          disabled={visibleSelectedCount === 0}
        >
          Снять выделение
        </button>
        <span className="hint">Чекбокс раздела выбирает всю ветку.</span>
        <span
          className="ml-auto text-xs"
          style={{ color: 'var(--color-text-2)' }}
          data-testid="picker-counter"
        >
          Выбрано <strong>{selectedCount}</strong> из {requirements.length}
          {visibleSelectedCount < selectedCount ? (
            <span style={{ color: 'var(--color-text-3)' }}>
              {' '}
              (из них видно {visibleSelectedCount})
            </span>
          ) : null}
        </span>
      </div>

      {/* §2.12.1 · невидимые выбранные не теряются — предупреждаем явно */}
      {visibleSelectedCount < selectedCount ? (
        <div
          className="flex flex-none items-start gap-2 rounded-lg p-2.5 text-xs"
          style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }}
          data-testid="picker-hidden-hint"
        >
          <TriangleAlert className="icon-sm mt-0.5 flex-none" aria-hidden />
          <span>
            Невидимые из-за фильтра требования остаются выбранными — в выгрузку попадут все{' '}
            {selectedCount}.
          </span>
        </div>
      ) : null}

      {hiddenCount > 0 ? (
        <span className="hint flex-none" data-testid="picker-hidden-count">
          {hiddenLabel(hiddenCount)}
        </span>
      ) : null}

      {/* Requirement list: ФТ tree + НФТ flat */}
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border p-0.5"
        style={{ borderColor: 'var(--color-border)' }}
        data-testid="picker-list"
      >
        {visible.length === 0 ? (
          <p className="py-4 text-center text-sm" style={{ color: 'var(--color-text-3)' }}>
            Нет требований, подходящих под фильтры.
          </p>
        ) : (
          <>
            {filteredFunctional.length > 0 && (
              <div
                className="overflow-hidden rounded-lg border"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <div
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wide"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}
                >
                  Функциональные требования ({filteredFunctional.length})
                </div>
                {fnFlat.map(({ req, hasChildren }, i) => (
                  <PickerRow
                    key={req.slug}
                    req={req}
                    {...(fnGuides[i] ? { guides: fnGuides[i] } : {})}
                    hasChildren={hasChildren}
                    state={branchState(req.slug)}
                    onToggle={toggleBranch}
                  />
                ))}
              </div>
            )}

            {filteredNfr.length > 0 && (
              <div
                className="overflow-hidden rounded-lg border"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <div
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wide"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}
                >
                  Нефункциональные требования ({filteredNfr.length})
                </div>
                {filteredNfr.map((r) => (
                  <PickerRow
                    key={r.slug}
                    req={r}
                    hasChildren={false}
                    state={branchState(r.slug)}
                    onToggle={toggleBranch}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
