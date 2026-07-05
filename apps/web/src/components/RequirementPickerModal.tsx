import { useState, useMemo } from 'react';
import { Search, TriangleAlert } from 'lucide-react';
import type { Criticality, Requirement } from '@po/core';
import { CRITICALITIES } from '@po/core';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { plural } from '../lib/plural';
import { CriticalityBadge } from './badges';
import { Modal } from './Modal';
import { buildForest, type TreeNode } from '../lib/tree';
import { buildLineGuides } from '../lib/treeLines';
import type { VisibleRow } from '../lib/visibility';

export interface RequirementPickerModalProps {
  title: string;
  requirements: Requirement[];
  initialSelected?: Set<string>;
  confirmLabel?: string;
  modalTestid?: string;
  onClose: () => void;
  onConfirm: (selected: Set<string>) => void;
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
function hiddenLabel(n: number): string {
  return `${n} ${plural(n, 'требование скрыто', 'требования скрыты', 'требований скрыто')} фильтрами`;
}

export function RequirementPickerModal({
  title,
  requirements,
  initialSelected,
  confirmLabel = 'Далее →',
  modalTestid,
  onClose,
  onConfirm,
}: RequirementPickerModalProps): React.ReactElement {
  // §2.12.3: name search lives ABOVE the chip filters.
  const [search, setSearch] = useState('');
  const [critFilter, setCritFilter] = useState<Set<Criticality>>(new Set());
  const [implFilter, setImplFilter] = useState<'all' | 'planned' | 'done'>('all');
  const [quarterFilter, setQuarterFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<Set<string>>(
    () => initialSelected ?? new Set(requirements.map((r) => r.slug)),
  );

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
      const raw = r.source ?? '';
      const key = raw.trim().toLowerCase();
      if (!map.has(key)) {
        map.set(key, key === '' ? '' : raw.trim());
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
    if (sourceFilter.size > 0 && !sourceFilter.has((r.source ?? '').trim().toLowerCase()))
      return false;
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
    setSelected((s) => {
      const next = new Set(s);
      for (const r of visible) next.add(r.slug);
      return next;
    });
  }

  function deselectAllVisible(): void {
    setSelected((s) => {
      const next = new Set(s);
      for (const r of visible) next.delete(r.slug);
      return next;
    });
  }

  function toggleReq(slug: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
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

  const footer = (
    <>
      {selectedCount === 0 ? (
        <span className="hint mr-auto self-center" data-testid="export-next-hint">
          Выберите хотя бы одно требование
        </span>
      ) : hiddenCount > 0 ? (
        <span className="hint mr-auto self-center" data-testid="picker-hidden-count">
          {hiddenLabel(hiddenCount)}
        </span>
      ) : null}
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Отменить
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={selectedCount === 0}
        data-testid="export-next"
        title={selectedCount === 0 ? 'Выберите хотя бы одно требование' : undefined}
        onClick={() => onConfirm(selected)}
      >
        {confirmLabel} ({selectedCount})
      </button>
    </>
  );

  const chipStyle = (on: boolean): React.CSSProperties =>
    on
      ? {
          background: 'var(--color-primary)',
          color: '#fff',
          borderColor: 'var(--color-primary)',
        }
      : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' };

  return (
    <Modal
      title={title}
      onClose={onClose}
      widthClass="max-w-2xl"
      testid={modalTestid}
      footer={footer}
    >
      <div className="space-y-4">
        {/* §2.12.3 · поиск по имени — над списком и фильтрами */}
        <div className="relative">
          <Search
            className="icon-sm t3 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
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
          className="space-y-4 rounded-lg p-3"
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
                {availableQuarters.map((key) => {
                  const label = key.replace('-', ' ');
                  return (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full border px-2.5 py-1 text-xs font-medium"
                      style={chipStyle(quarterFilter.has(key))}
                      aria-pressed={quarterFilter.has(key)}
                      onClick={() => toggleQuarter(key)}
                      data-testid={`export-filter-q-${key}`}
                    >
                      {label}
                    </button>
                  );
                })}
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

        {/* Group: Выбор — select all / deselect + двухчастный счётчик (§2.12.1) */}
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
          role="group"
          aria-label="Выбор"
        >
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
          <span
            className="text-xs"
            style={{ color: 'var(--color-text-2)' }}
            data-testid="picker-counter"
          >
            Выбрано <strong>{selectedCount}</strong>
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
            className="flex items-start gap-2 rounded-lg p-2.5 text-xs"
            style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }}
            data-testid="picker-hidden-hint"
          >
            <TriangleAlert className="icon-sm mt-0.5 flex-none" aria-hidden="true" />
            <span>
              Невидимые из-за фильтра требования остаются выбранными — в экспорт попадут все{' '}
              {selectedCount}.
            </span>
          </div>
        ) : null}

        {/* Requirement list: ФТ tree + НФТ flat */}
        <div className="max-h-72 space-y-3 overflow-y-auto">
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
                  {fnFlat.map(({ req, depth: _depth, hasChildren }, i) => (
                    <label
                      key={req.slug}
                      className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
                      style={{ borderTop: '1px solid var(--color-border)' }}
                      data-testid={`export-item-${req.slug}`}
                    >
                      {fnGuides[i].map((guide, k) => (
                        <span
                          key={k}
                          className={`tree-guide tree-guide--${guide}`}
                          aria-hidden="true"
                          style={{
                            flexShrink: 0,
                            width: '16px',
                            alignSelf: 'stretch',
                            position: 'relative',
                          }}
                        />
                      ))}
                      <span
                        className="flex-none text-xs"
                        style={{ color: 'var(--color-text-3)' }}
                        aria-hidden="true"
                      >
                        {hasChildren ? '▾' : '•'}
                      </span>
                      <input
                        type="checkbox"
                        className="flex-none"
                        checked={selected.has(req.slug)}
                        onChange={() => toggleReq(req.slug)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{req.name}</p>
                        {!req.implemented && req.targetQuarter ? (
                          <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                            {req.targetQuarter} {req.targetYear ?? ''}
                          </p>
                        ) : null}
                      </div>
                      <span className="flex-none">
                        <CriticalityBadge criticality={req.criticality} />
                      </span>
                    </label>
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
                    <label
                      key={r.slug}
                      className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
                      style={{ borderTop: '1px solid var(--color-border)' }}
                      data-testid={`export-item-${r.slug}`}
                    >
                      <span
                        className="flex-none text-xs"
                        style={{ color: 'var(--color-text-3)' }}
                        aria-hidden="true"
                      >
                        •
                      </span>
                      <input
                        type="checkbox"
                        className="flex-none"
                        checked={selected.has(r.slug)}
                        onChange={() => toggleReq(r.slug)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.name}</p>
                        {!r.implemented && r.targetQuarter ? (
                          <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                            {r.targetQuarter} {r.targetYear ?? ''}
                          </p>
                        ) : null}
                      </div>
                      <span className="flex-none">
                        <CriticalityBadge criticality={r.criticality} />
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
