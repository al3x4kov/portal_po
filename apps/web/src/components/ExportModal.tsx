import { useState } from 'react';
import type { Requirement } from '@po/core';
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

  async function doExport(format: ExportFormat): Promise<void> {
    setExportError(null);
    setExporting(format);
    try {
      let blob: Blob;
      let filename: string;

      if (format === 'xlsx') {
        ({ blob, filename } = await projectsApi.exportXlsx(projectId));
      } else {
        if (selected.size === 0) return;
        if (selected.size >= requirements.length) {
          ({ blob, filename } = await projectsApi.export(projectId, format));
        } else {
          ({ blob, filename } = await projectsApi.exportSelected(projectId, format, [...selected]));
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
