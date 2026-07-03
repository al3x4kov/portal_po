import { useState, useMemo } from 'react';
import type { Criticality, Requirement } from '@po/core';
import { CRITICALITIES } from '@po/core';
import { CRITICALITY_LABEL } from '../lib/criticality';
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

export function RequirementPickerModal({
  title,
  requirements,
  initialSelected,
  confirmLabel = 'Далее →',
  modalTestid,
  onClose,
  onConfirm,
}: RequirementPickerModalProps): React.ReactElement {
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

  const availableSources = useMemo(() => {
    const vals = new Set<string>();
    for (const r of requirements) {
      vals.add(r.source ?? '');
    }
    return [...vals].sort((a, b) => {
      if (a === '') return 1; // «Не задан» — в конец
      if (b === '') return -1;
      return a.localeCompare(b);
    });
  }, [requirements]);

  const functional = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION'),
    [requirements],
  );
  const nfr = useMemo(() => requirements.filter((r) => r.type === 'NFR'), [requirements]);

  function passesFilters(r: Requirement): boolean {
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
    if (sourceFilter.size > 0 && !sourceFilter.has(r.source ?? '')) return false;
    return true;
  }

  const filteredFunctional = useMemo(
    () => functional.filter(passesFilters),
    [functional, critFilter, implFilter, quarterFilter, sourceFilter], // passesFilters is stable w.r.t. these deps
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
    [nfr, critFilter, implFilter, quarterFilter, sourceFilter], // passesFilters is stable w.r.t. these deps
  );

  const visible = useMemo(
    () => [...filteredFunctional, ...filteredNfr],
    [filteredFunctional, filteredNfr],
  );

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.slug));
  const selectedCount = selected.size;

  function toggleAll(): void {
    if (allVisibleSelected) {
      setSelected((s) => {
        const next = new Set(s);
        for (const r of visible) next.delete(r.slug);
        return next;
      });
    } else {
      setSelected((s) => {
        const next = new Set(s);
        for (const r of visible) next.add(r.slug);
        return next;
      });
    }
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
        <span
          className="mr-auto self-center text-xs"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="export-next-hint"
        >
          Выберите хотя бы одно требование
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

  return (
    <Modal
      title={title}
      onClose={onClose}
      widthClass="max-w-2xl"
      testid={modalTestid}
      footer={footer}
    >
      <div className="space-y-4">
        {/* Filters */}
        <div
          className="space-y-3 rounded-lg p-3"
          style={{ background: 'var(--color-surface-2)' }}
          data-testid="export-filter-zone"
        >
          <p
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--color-text-3)' }}
          >
            Фильтры
          </p>
          {/* Criticality chips */}
          <div className="flex flex-wrap gap-1.5">
            {CRITICALITIES.map((c) => (
              <button
                key={c}
                type="button"
                className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                style={
                  critFilter.has(c)
                    ? {
                        background: 'var(--color-primary)',
                        color: '#fff',
                        borderColor: 'var(--color-primary)',
                      }
                    : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }
                }
                onClick={() => toggleCrit(c)}
                data-testid={`export-filter-crit-${c}`}
              >
                {CRITICALITY_LABEL[c]}
              </button>
            ))}
          </div>
          {/* Implementation filter */}
          <div className="flex gap-1.5">
            {(['all', 'done', 'planned'] as const).map((v) => {
              const labels = { all: 'Все', done: 'Реализовано', planned: 'Запланировано' };
              return (
                <button
                  key={v}
                  type="button"
                  className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                  style={
                    implFilter === v
                      ? {
                          background: 'var(--color-primary)',
                          color: '#fff',
                          borderColor: 'var(--color-primary)',
                        }
                      : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }
                  }
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
          {/* Source chips — only when there are 2+ distinct values */}
          {availableSources.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {availableSources.map((val) => (
                <button
                  key={val === '' ? '__empty__' : val}
                  type="button"
                  className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                  style={
                    sourceFilter.has(val)
                      ? {
                          background: 'var(--color-primary)',
                          color: '#fff',
                          borderColor: 'var(--color-primary)',
                        }
                      : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }
                  }
                  onClick={() => toggleSource(val)}
                  data-testid={`export-filter-src-${val === '' ? 'empty' : val}`}
                >
                  {val === '' ? 'Не задан' : val}
                </button>
              ))}
            </div>
          ) : null}
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
                    style={
                      quarterFilter.has(key)
                        ? {
                            background: 'var(--color-primary)',
                            color: '#fff',
                            borderColor: 'var(--color-primary)',
                          }
                        : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }
                    }
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

        {/* Select / deselect all */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-xs underline"
            style={{ color: 'var(--color-primary)' }}
            onClick={toggleAll}
            data-testid="export-toggle-all"
          >
            {allVisibleSelected ? 'Снять выделение' : 'Выбрать все'}
          </button>
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            {selectedCount} из {requirements.length} выбрано
          </span>
        </div>

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
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{req.name}</p>
                        <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                          {req.criticality}
                          {!req.implemented && req.targetQuarter
                            ? ` · ${req.targetQuarter} ${req.targetYear ?? ''}`
                            : ''}
                        </p>
                      </div>
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
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.name}</p>
                        <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                          {r.criticality}
                          {!r.implemented && r.targetQuarter
                            ? ` · ${r.targetQuarter} ${r.targetYear ?? ''}`
                            : ''}
                        </p>
                      </div>
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
