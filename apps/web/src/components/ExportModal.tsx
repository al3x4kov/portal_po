import { useState, useMemo } from 'react';
import type { Criticality, Requirement, TargetQuarter } from '@po/core';
import { CRITICALITIES, TARGET_QUARTERS } from '@po/core';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { Modal } from './Modal';
import { projectsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';

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
  const [quarterFilter, setQuarterFilter] = useState<Set<TargetQuarter>>(new Set());
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const visible = useMemo(() => {
    return requirements.filter((r) => {
      if (critFilter.size > 0 && !critFilter.has(r.criticality)) return false;
      if (implFilter === 'planned' && r.implemented) return false;
      if (implFilter === 'done' && !r.implemented) return false;
      if (quarterFilter.size > 0 && (!r.targetQuarter || !quarterFilter.has(r.targetQuarter)))
        return false;
      return true;
    });
  }, [requirements, critFilter, implFilter, quarterFilter]);

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

  function toggleCrit(c: Criticality): void {
    setCritFilter((s) => {
      const next = new Set(s);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function toggleQuarter(q: TargetQuarter): void {
    setQuarterFilter((s) => {
      const next = new Set(s);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  }

  const selectedCount = selected.size;

  async function doExport(format: ExportFormat): Promise<void> {
    setExportError(null);
    setExporting(format);
    try {
      const { blob, filename } =
        format === 'xlsx'
          ? await projectsApi.exportXlsx(projectId)
          : await projectsApi.export(projectId, format);
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
            {/* Quarter (only shown when 'planned') */}
            {implFilter === 'planned' ? (
              <div className="flex gap-1.5">
                {TARGET_QUARTERS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="rounded-full border px-2.5 py-1 text-xs font-medium"
                    style={
                      quarterFilter.has(q)
                        ? {
                            background: 'var(--color-primary)',
                            color: '#fff',
                            borderColor: 'var(--color-primary)',
                          }
                        : { borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }
                    }
                    onClick={() => toggleQuarter(q)}
                    data-testid={`export-filter-q-${q}`}
                  >
                    {q}
                  </button>
                ))}
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

          {/* Requirement list */}
          <div
            className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {visible.length === 0 ? (
              <p className="py-4 text-center text-sm" style={{ color: 'var(--color-text-3)' }}>
                Нет требований, подходящих под фильтры.
              </p>
            ) : (
              visible.map((r) => (
                <label
                  key={r.slug}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
                  data-testid={`export-item-${r.slug}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 flex-none"
                    checked={selected.has(r.slug)}
                    onChange={() => {
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(r.slug)) next.delete(r.slug);
                        else next.add(r.slug);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.name}</p>
                    <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                      {r.type === 'FUNCTION' ? 'ФТ' : 'НФТ'} · {r.criticality}
                      {!r.implemented && r.targetQuarter
                        ? ` · ${r.targetQuarter} ${r.targetYear ?? ''}`
                        : ''}
                    </p>
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      ) : (
        /* Format selection step */
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Выбрано требований: <strong>{selectedCount}</strong>. Выберите формат выгрузки:
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
                {exporting === fmt ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                    Экспорт…
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Примечание: фильтрация по выбранным требованиям применяется в Excel. Архивы (.zip /
            .tar.gz) содержат весь проект целиком.
          </p>
        </div>
      )}
    </Modal>
  );
}
