import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import type { ExportOptionalField, Requirement } from '@po/core';
import { EXPORT_OPTIONAL_FIELDS } from '@po/core';
import { useProject, useRequirements } from '../api/hooks';
import { projectsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { RequirementPicker } from '../components/RequirementPicker';
import {
  AsideActions,
  AsideTitle,
  Banner,
  WorkspaceAside,
  WorkspaceScreen,
} from '../components/WorkspaceScreen';

type ExportFormat = 'xlsx' | 'zip' | 'targz';

const FORMATS: ReadonlyArray<{ id: ExportFormat; title: string; hint: string; ext: string }> = [
  {
    id: 'zip',
    title: 'Архив .zip',
    hint: 'Полный проект в OpenSpec-разметке, пригоден для повторного импорта',
    ext: 'zip',
  },
  {
    id: 'targz',
    title: 'Архив .tar.gz',
    hint: 'То же содержимое, удобно для Linux-окружений',
    ext: 'tar.gz',
  },
  {
    id: 'xlsx',
    title: 'Excel .xlsx',
    hint: 'Лист «Требования» — таблица портала; только выгрузка, обратно не импортируется',
    ext: 'xlsx',
  },
];

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
export function buildPreview(selected: Record<ExportOptionalField, boolean>): {
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

/** Число связей, у которых оба конца попали в выборку. */
function countInnerLinks(reqs: Requirement[], selected: Set<string>): number {
  let n = 0;
  for (const r of reqs) {
    if (!selected.has(r.slug)) continue;
    for (const l of r.links) {
      // Каждую пару считаем один раз: обратные связи хранятся с обеих сторон.
      if (selected.has(l.targetSlug) && r.slug < l.targetSlug) n += 1;
    }
  }
  return n;
}

/**
 * Полноэкранный экспорт проекта (макеты Э1–Э4, docs/design/screens/flow-e*.html).
 *
 * Выбор требований и итог видны одновременно: дерево с чекбоксами слева,
 * формат + живой состав выгрузки справа. Прежний двухшаговый диалог
 * («выбор» → «формат») схлопнут в один экран, поэтому состав пересчитывается
 * на лету, а ошибка сервера не теряет выбор — повтор в один клик.
 */
export function ExportPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const requirements = useMemo(() => reqQuery.data?.requirements ?? [], [reqQuery.data]);

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [format, setFormat] = useState<ExportFormat>('zip');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [optionalFields, setOptionalFields] = useState<Record<ExportOptionalField, boolean>>({
    source: true,
    description: true,
    info: true,
    links: true,
  });

  // По умолчанию выбран весь проект; ждём загрузку требований, чтобы не
  // «схлопнуть» выбор в пустое множество на первом рендере.
  const effectiveSelected = selected ?? new Set(requirements.map((r) => r.slug));
  const selectedCount = effectiveSelected.size;

  const selectedFields = EXPORT_OPTIONAL_FIELDS.filter((f) => optionalFields[f]);
  const preview = buildPreview(optionalFields);

  const stats = useMemo(() => {
    const picked = requirements.filter((r) => effectiveSelected.has(r.slug));
    return {
      functional: picked.filter((r) => r.type === 'FUNCTION').length,
      nfr: picked.filter((r) => r.type === 'NFR').length,
      links: countInnerLinks(requirements, effectiveSelected),
    };
  }, [requirements, effectiveSelected]);

  const projectName = projectQuery.data?.name ?? id;
  const fileName = `${projectName}-${new Date().toISOString().slice(0, 10)}.${
    FORMATS.find((f) => f.id === format)!.ext
  }`;

  async function doExport(): Promise<void> {
    if (selectedCount === 0) return;
    setExportError(null);
    setExporting(true);
    try {
      const whole = selectedCount >= requirements.length;
      const { blob, filename } =
        format === 'xlsx'
          ? whole
            ? await projectsApi.exportXlsx(id, selectedFields)
            : await projectsApi.exportSelected(id, 'xlsx', [...effectiveSelected], selectedFields)
          : whole
            ? await projectsApi.export(id, format, selectedFields)
            : await projectsApi.exportSelected(id, format, [...effectiveSelected], selectedFields);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      navigate(`/p/${id}`);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <WorkspaceScreen
      projectId={id}
      action="export"
      title={`Экспорт проекта · ${projectName}`}
      mainPath={projectQuery.data?.mainPath ?? ''}
      testid="export-modal"
      footerLeft={
        <span className="hint" data-testid="export-footer-hint">
          {selectedCount === 0
            ? 'Отметьте требования в дереве — можно целыми ветками.'
            : `К выгрузке: ${selectedCount} ${selectedCount === 1 ? 'требование' : 'требований'}.`}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        <RequirementPicker
          requirements={requirements}
          selected={effectiveSelected}
          onChange={setSelected}
          testid="export-picker"
        />
      </div>

      <WorkspaceAside testid="export-aside">
        {exportError ? (
          <Banner tone="danger" testid="export-error" role="alert">
            <strong>Не удалось выгрузить проект.</strong> {exportError} Выбор и настройки сохранены
            — можно повторить.
          </Banner>
        ) : null}

        <div>
          <AsideTitle>Формат</AsideTitle>
          <div className="mt-2 flex flex-col gap-2">
            {FORMATS.map((f) => {
              const on = format === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  className="flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors"
                  style={{
                    borderColor: on ? 'var(--color-primary)' : 'var(--color-border)',
                    background: on ? 'var(--color-primary-soft)' : 'var(--color-bg)',
                    boxShadow: on ? '0 0 0 1px var(--color-primary)' : undefined,
                  }}
                  role="radio"
                  aria-checked={on}
                  data-testid={`export-fmt-${f.id}`}
                  onClick={() => setFormat(f.id)}
                >
                  <span
                    className="mt-0.5 h-3.5 w-3.5 flex-none rounded-full border"
                    style={{
                      borderColor: on ? 'var(--color-primary)' : 'var(--color-border)',
                      borderWidth: on ? 4 : 1.5,
                      background: 'var(--color-surface)',
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{f.title}</span>
                    <span className="mt-0.5 block text-xs" style={{ color: 'var(--color-text-3)' }}>
                      {f.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="rounded-lg border p-3"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
          data-testid="export-summary"
        >
          <AsideTitle>Состав экспорта</AsideTitle>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--color-text-2)' }}>Функциональных требований</dt>
              <dd className="font-semibold" data-testid="export-summary-fn">
                {stats.functional}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--color-text-2)' }}>Нефункциональных</dt>
              <dd className="font-semibold" data-testid="export-summary-nfr">
                {stats.nfr}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--color-text-2)' }}>Связей внутри выборки</dt>
              <dd className="font-semibold" data-testid="export-summary-links">
                {stats.links}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--color-text-2)' }}>Файл</dt>
              <dd
                className="min-w-0 truncate font-semibold"
                title={fileName}
                data-testid="export-summary-file"
              >
                {selectedCount === 0 ? '—' : fileName}
              </dd>
            </div>
          </dl>
        </div>

        {/* T-203: «Данные для выгрузки» — two groups (mandatory locks + optional toggles). */}
        <div>
          <AsideTitle>Данные для выгрузки</AsideTitle>
          <div
            className="mt-2 space-y-3 rounded-lg p-3"
            style={{ background: 'var(--color-surface-2)' }}
          >
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

        {format === 'xlsx' ? (
          <Banner tone="info" testid="export-xlsx-note">
            Excel — только выгрузка таблицы: вложенность передаётся колонкой «родитель», повторный
            импорт из .xlsx не поддерживается.
          </Banner>
        ) : null}

        {selectedCount === 0 ? (
          <Banner tone="info" testid="export-empty-hint">
            Отметьте требования в дереве слева — можно целыми ветками.
          </Banner>
        ) : selectedCount < requirements.length ? (
          <Banner tone="warning" testid="export-partial-hint">
            Выгрузка частичная: {selectedCount} из {requirements.length} требований проекта.
          </Banner>
        ) : null}

        <AsideActions>
          <button
            type="button"
            className="btn btn-primary w-full justify-center"
            data-testid="export-run"
            disabled={selectedCount === 0 || exporting}
            title={selectedCount === 0 ? 'Выберите хотя бы одно требование' : undefined}
            onClick={() => void doExport()}
          >
            <Download className="icon-sm" aria-hidden="true" />
            {exporting ? 'Экспортируем…' : `Экспортировать (${selectedCount})`}
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full justify-center"
            data-testid="export-cancel"
            onClick={() => navigate(`/p/${id}`)}
          >
            Отмена
          </button>
        </AsideActions>
      </WorkspaceAside>
    </WorkspaceScreen>
  );
}
