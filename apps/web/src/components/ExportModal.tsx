import { useState } from 'react';
import type { ExportOptionalField, Requirement } from '@po/core';
import { EXPORT_OPTIONAL_FIELDS } from '@po/core';
import { Modal } from './Modal';
import { projectsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { RequirementPickerModal } from './RequirementPickerModal';

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

/** Mandatory fields — always exported, rendered as checked+disabled locks. */
const MANDATORY_FIELDS: { testid: string; label: string }[] = [
  { testid: 'export-field-lock-name', label: 'Название' },
  { testid: 'export-field-lock-criticality', label: 'Критичность' },
  { testid: 'export-field-lock-impl', label: 'Статус реализации' },
];

/** Toggleable optional fields (order = @po/core EXPORT_OPTIONAL_FIELDS). */
const OPTIONAL_FIELD_LABELS: Record<ExportOptionalField, string> = {
  source: 'Источник требования',
  description: 'Описание',
  info: 'Справочная информация',
  links: 'Связи',
};

/**
 * Preview strings for the Excel columns and OpenSpec sections a given selection
 * produces (mirrors the mockup `previewText` in design-out/task2/export-format.html).
 */
function buildPreview(selected: Record<ExportOptionalField, boolean>): {
  cols: string;
  secs: string;
} {
  const cols = ['Требование', 'Тип', 'Критичность', 'Реализация'];
  const secs: string[] = [];
  if (selected.source) cols.push('Источник');
  if (selected.description) {
    cols.push('Описание');
    secs.push('описание/сценарии');
  }
  if (selected.info) {
    cols.push('Справочная информация');
    secs.push('#### Info');
  }
  if (selected.links) {
    cols.push('Связи');
    secs.push('#### Links');
  }
  const secBase = 'заголовок + критичность + реализация';
  const secs2 = secs.length ? `${secBase} + ${secs.join(' + ')}` : `${secBase} (минимум)`;
  return { cols: cols.join(' · '), secs: secs2 };
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
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [optionalFields, setOptionalFields] = useState<Record<ExportOptionalField, boolean>>({
    source: true,
    description: true,
    info: true,
    links: true,
  });

  // All hooks above — conditional return is safe below

  if (step === 'select') {
    return (
      <RequirementPickerModal
        title="Выбор требований для экспорта"
        requirements={requirements}
        initialSelected={selected}
        modalTestid="export-modal"
        onClose={onClose}
        onConfirm={(sel) => {
          setSelected(sel);
          setStep('format');
        }}
      />
    );
  }

  const selectedCount = selected.size;

  // Enabled optional fields in the fixed @po/core order. Built explicitly from
  // the toggle state: all-on → full list (≡ "all"), all-off → [] (minimum).
  const selectedFields = EXPORT_OPTIONAL_FIELDS.filter((f) => optionalFields[f]);
  const preview = buildPreview(optionalFields);

  async function doExport(format: ExportFormat): Promise<void> {
    setExportError(null);
    setExporting(format);
    try {
      let blob: Blob;
      let filename: string;

      if (selected.size === 0) return;

      if (format === 'xlsx') {
        if (selected.size >= requirements.length) {
          ({ blob, filename } = await projectsApi.exportXlsx(projectId, selectedFields));
        } else {
          ({ blob, filename } = await projectsApi.exportSelected(
            projectId,
            'xlsx',
            [...selected],
            selectedFields,
          ));
        }
      } else if (selected.size >= requirements.length) {
        ({ blob, filename } = await projectsApi.export(projectId, format, selectedFields));
      } else {
        ({ blob, filename } = await projectsApi.exportSelected(
          projectId,
          format,
          [...selected],
          selectedFields,
        ));
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

  const footer = (
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
      title="Формат выгрузки"
      onClose={onClose}
      widthClass="max-w-2xl"
      testid="export-modal"
      footer={footer}
    >
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
          Выбрано <strong>{selectedCount}</strong> требований для архива. Выберите формат выгрузки:
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

        {/* T-203: «Данные для выгрузки» — two groups (mandatory locks + optional toggles). */}
        <div className="space-y-3 rounded-lg p-3" style={{ background: 'var(--color-surface-2)' }}>
          <fieldset>
            <legend
              className="mb-1.5 text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              Обязательные данные
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {MANDATORY_FIELDS.map((f) => (
                <label
                  key={f.testid}
                  className="flex cursor-not-allowed items-center gap-2 rounded px-1.5 py-1"
                  style={{ opacity: 0.72 }}
                  title="Всегда включается в выгрузку"
                >
                  <input
                    type="checkbox"
                    checked
                    disabled
                    readOnly
                    data-testid={f.testid}
                    style={{ accentColor: 'var(--color-text-3)' }}
                  />
                  <span className="text-sm" style={{ color: 'var(--color-text-2)' }}>
                    {f.label}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    style={{ color: 'var(--color-text-3)' }}
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
            <legend
              className="mb-1.5 text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              Дополнительные данные
            </legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {EXPORT_OPTIONAL_FIELDS.map((field) => (
                <label
                  key={field}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-surface)]"
                >
                  <input
                    type="checkbox"
                    checked={optionalFields[field]}
                    data-testid={`export-field-${field}`}
                    style={{ accentColor: 'var(--color-primary)' }}
                    onChange={(e) =>
                      setOptionalFields((prev) => ({ ...prev, [field]: e.target.checked }))
                    }
                  />
                  <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                    {OPTIONAL_FIELD_LABELS[field]}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {/* Preview hint — Excel columns + OpenSpec sections for the current selection. */}
        <div
          className="rounded-lg p-3 text-xs leading-relaxed"
          style={{ background: 'var(--color-primary-soft)', color: 'var(--color-text-2)' }}
          data-testid="export-fields-preview"
        >
          <p>
            <strong>Колонки Excel:</strong> {preview.cols}
          </p>
          <p className="mt-1">
            <strong>Секции OpenSpec (.md):</strong> {preview.secs}
          </p>
        </div>

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
    </Modal>
  );
}
