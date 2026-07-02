import { useState, useMemo } from 'react';
import type { Criticality, Requirement } from '@po/core';
import { CRITICALITIES } from '@po/core';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { Modal } from './Modal';
import { projectsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { buildForest, type TreeNode } from '../lib/tree';
import { buildLineGuides } from '../lib/treeLines';
import type { VisibleRow } from '../lib/visibility';

type ExportFormat = 'xlsx' | 'zip' | 'targz';

interface ExportModalProps {
  projectId: string;
  requirements: Requirement[];
  onClose: () => void;
}

type Step = 'select' | 'format';

const FORMAT_LABELS: Record<ExportFormat, string> = {
  xlsx: 'Excel (.xlsx)',
  zip: '.zip (OpenSpec)',
  targz: '.tar.gz (OpenSpec)',
};

/** Recursively flatten a tree forest into DFS order with depth info. */
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

export function ExportModal({
  projectId,
  requirements,
  onClose,
}: ExportModalProps): React.ReactElement {
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(requirements.map((r) => r.slug)),
  );
  const [critFilter, setCritFilter] = useState<Set<Criticality>>(new Set());
  const [implFilter, setImplFilter] = useState<'all' | 'planned' | 'done'>('all');
  // T-521: quarter filter key is "Q2-2026" (quarter + year combo)
  const [quarterFilter, setQuarterFilter] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // T-521: compute unique Q+Y pairs from requirements with implemented: false
  const availableQuarters = useMemo(() => {
    const pairs = new Set<string>();
    for (const r of requirements) {
      if (!r.implemented && r.targetQuarter && r.targetYear) {
        pairs.add(`${r.targetQuarter}-${r.targetYear}`);
      }
    }
    return [...pairs].sort();
  }, [requirements]);

  // T-520: split into functional and NFR
  const functional = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION'),
    [requirements],
  );
  const nfr = useMemo(() => requirements.filter((r) => r.type === 'NFR'), [requirements]);

  /** Apply criticality / impl / quarter filters to a flat list of requirements */
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
    return true;
  }

  // T-520: filtered functional items, then build tree from those
  const filteredFunctional = useMemo(
    () => functional.filter(passesFilters),
    [functional, critFilter, implFilter, quarterFilter], // passesFilters is stable w.r.t. these deps
  );

  const fnFlat = useMemo(() => {
    const forest = buildForest(filteredFunctional);
    return flattenTree(forest);
  }, [filteredFunctional]);

  // Build VisibleRow-compatible objects for buildLineGuides
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

  // T-520: filtered NFR items (flat list)
  const filteredNfr = useMemo(
    () => nfr.filter(passesFilters),
    [nfr, critFilter, implFilter, quarterFilter], // passesFilters is stable w.r.t. these deps
  );

  // Combined visible list for toggleAll logic
  const visible = useMemo(
    () => [...filteredFunctional, ...filteredNfr],
    [filteredFunctional, filteredNfr],
  );

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.slug));

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

  // T-521: toggle a "Q2-2026" key
  function toggleQuarter(key: string): void {
    setQuarterFilter((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedCount = selected.size;

  async function doExport(format: ExportFormat): Promise<void> {
    setExportError(null);
    setExporting(format);
    try {
      let blob: Blob;
      let filename: string;

      if (format === 'xlsx') {
        ({ blob, filename } = await projectsApi.exportXlsx(projectId));
      } else {
        // zip or targz
        if (selected.size === 0) return; // defensive — button should be disabled
        if (selected.size >= requirements.length) {
          // All selected — use the existing GET endpoint (full project)
          ({ blob, filename } = await projectsApi.export(projectId, format));
        } else {
          // Partial selection — use the new POST /export/selected endpoint
          ({ blob, filename } = await projectsApi.exportSelected(projectId, format, [
            ...selected,
          ]));
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  }

  const footer =
    step === 'select' ? (
      <>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Отменить
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={selectedCount === 0}
          data-testid="export-next"
          onClick={() => setStep('format')}
        >
          Далее → ({selectedCount})
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn btn-secondary" onClick={() => setStep('select')}>
          ← Назад
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Отменить
        </button>
      </>
    );

  return (
    <Modal
      title={step === 'select' ? 'Выбор требований для экспорта' : 'Формат выгрузки'}
      onClose={onClose}
      widthClass="max-w-2xl"
      testid="export-modal"
      footer={footer}
    >
      {step === 'select' ? (
        <div className="space-y-4">
          {/* Filters */}
          <div
            className="space-y-3 rounded-lg p-3"
            style={{ background: 'var(--color-surface-2)' }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              Фильтры
            </p>
            {/* Criticality */}
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
            {/* Implementation */}
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
                    onClick={() => setImplFilter(v)}
                    data-testid={`export-filter-impl-${v}`}
                  >
                    {labels[v]}
                  </button>
                );
              })}
            </div>
            {/* T-521: Quarter chips — only shown when 'planned' and there are available Q+Y pairs */}
            {implFilter === 'planned' && availableQuarters.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {availableQuarters.map((key) => {
                  // Format "Q2-2026" → "Q2 2026"
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

          {/* T-520: Requirement list split into ФТ tree + НФТ flat sections */}
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="py-4 text-center text-sm" style={{ color: 'var(--color-text-3)' }}>
                Нет требований, подходящих под фильтры.
              </p>
            ) : (
              <>
                {/* Functional requirements — tree view */}
                {filteredFunctional.length > 0 && (
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <div
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wide"
                      style={{
                        background: 'var(--color-surface-2)',
                        color: 'var(--color-text-3)',
                      }}
                    >
                      Функциональные требования ({filteredFunctional.length})
                    </div>
                    {fnFlat.map(({ req, depth, hasChildren }, i) => (
                      <label
                        key={req.slug}
                        className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
                        style={{ borderTop: '1px solid var(--color-border)' }}
                        data-testid={`export-item-${req.slug}`}
                      >
                        {/* T-520: tree line guides */}
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
                        {/* Chevron / bullet indicator */}
                        <span
                          className="flex-none text-xs"
                          style={{ color: 'var(--color-text-3)' }}
                          aria-hidden="true"
                        >
                          {hasChildren ? (depth === 0 ? '▾' : '▾') : '•'}
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

                {/* NFR — flat list */}
                {filteredNfr.length > 0 && (
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <div
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wide"
                      style={{
                        background: 'var(--color-surface-2)',
                        color: 'var(--color-text-3)',
                      }}
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
      ) : (
        /* Format selection step */
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Выбрано <strong>{selectedCount}</strong> требований для архива. Выберите формат
            выгрузки:
          </p>
          {exportError ? (
            <p
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              role="alert"
            >
              {exportError}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((fmt) => (
              <button
                key={fmt}
                type="button"
                className="btn btn-secondary flex-col gap-1 py-4 text-center"
                disabled={exporting !== null}
                data-testid={`export-fmt-${fmt}`}
                onClick={() => void doExport(fmt)}
              >
                <span className="text-lg" aria-hidden="true">
                  {fmt === 'xlsx' ? '📊' : '📦'}
                </span>
                <span className="text-sm font-medium">{FORMAT_LABELS[fmt]}</span>
                {fmt !== 'xlsx' ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                    {selectedCount} файлов
                  </span>
                ) : null}
                {exporting === fmt ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                    Экспорт…
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Примечание: фильтрация по выбранным требованиям применяется в Excel и архивах.
            {selectedCount < requirements.length
              ? ' Архив будет содержать только выбранные требования.'
              : ' Архив будет содержать весь проект целиком.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
