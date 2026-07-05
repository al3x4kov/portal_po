import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Upload, X } from 'lucide-react';
import { AuxLayout } from '../components/AuxLayout';
import { BusyButton } from '../components/BusyButton';
import { useImportProject } from '../api/hooks';
import { errorMessage } from '../api/client';
import { rememberRecentProject } from '../lib/recentProjects';

const ACCEPTED = /\.(zip|tar\.gz|tgz)$/i;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * §2.3-4 / PO decision: project name is prefilled from the archive file name —
 * extension stripped, characters illegal in directory names replaced by «_».
 * The field stays editable.
 */
export function deriveProjectName(fileName: string): string {
  return fileName
    .replace(/\.(tar\.gz|tgz|zip)$/i, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim();
}

export function Import(): React.ReactElement {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const importMut = useImportProject();

  const pickFile = (f: File | null): void => {
    setError(null);
    if (f && !ACCEPTED.test(f.name)) {
      setFile(null);
      setError('Неподдерживаемый формат. Допустимы .zip или .tar.gz.');
      return;
    }
    setFile(f);
    if (f) setName(deriveProjectName(f.name));
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Выберите архив для импорта.');
      return;
    }
    try {
      const project = await importMut.mutateAsync({ name: name.trim(), file });
      rememberRecentProject(project);
      navigate(`/p/${encodeURIComponent(project.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const busy = importMut.isPending;
  const ready = Boolean(file) && name.trim().length > 0;
  // §2.3-2 / паттерн №1: текстовая причина дизейбла в футере.
  const footerHint = busy
    ? 'Не закрывайте вкладку до завершения'
    : !file && name.trim().length === 0
      ? 'Выберите архив и укажите имя'
      : !file
        ? 'Выберите архив'
        : name.trim().length === 0
          ? 'Укажите имя проекта'
          : 'Всё готово к импорту';

  return (
    <AuxLayout title="Импорт проекта" testid="import-page">
      <form className="card p-5 sm:p-6" onSubmit={submit} noValidate aria-busy={busy || undefined}>
        {/* 1. Дропзона / карточка выбранного файла (сначала файл, §2.3-4). */}
        <span className="label">
          Архив проекта{' '}
          <span style={{ color: 'var(--color-danger)' }} aria-hidden="true">
            *
          </span>
        </span>

        {file ? (
          <>
            <div
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
              data-testid="import-file-card"
            >
              <FileText
                className="icon flex-none"
                style={{ color: 'var(--color-primary)' }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-sm font-semibold"
                  title={file.name}
                  data-testid="import-file-name"
                >
                  {file.name}
                </div>
                <div className="hint">{formatSize(file.size)}</div>
              </div>
              {!busy ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm flex-none"
                  aria-label="Убрать файл"
                  title="Убрать файл"
                  data-testid="import-file-remove"
                  onClick={() => pickFile(null)}
                >
                  <X className="icon-sm" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {/* §2.3-3: видимый статус загрузки — прогресс-полоса + busy-кнопка. */}
            {busy ? (
              <div className="mt-3" data-testid="import-progress">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full"
                  style={{ background: 'var(--color-surface-2)' }}
                  role="progressbar"
                  aria-label="Импорт архива"
                >
                  <div
                    className="progress-indeterminate h-full w-1/3 rounded-full"
                    style={{ background: 'var(--color-primary)' }}
                  />
                </div>
                <p className="hint mt-1.5" aria-live="polite">
                  Импортируем… распаковка архива
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            className="w-full rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors hover:border-[var(--color-primary)]"
            style={
              dragOver
                ? { borderColor: 'var(--color-primary)', background: 'var(--color-primary-soft)' }
                : { borderColor: 'var(--color-border)' }
            }
            data-testid="import-dropzone"
            data-dragover={dragOver || undefined}
            aria-describedby="dz-hint"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              pickFile(e.dataTransfer.files[0] ?? null);
            }}
          >
            {dragOver ? (
              <>
                <Upload
                  className="icon mx-auto mb-2"
                  style={{ color: 'var(--color-primary)' }}
                  aria-hidden="true"
                />
                <span className="block text-sm font-bold" style={{ color: 'var(--color-primary)' }}>
                  Отпустите, чтобы загрузить
                </span>
              </>
            ) : (
              <>
                <Upload className="t3 icon mx-auto mb-2" aria-hidden="true" />
                <span className="block text-sm font-semibold">
                  Перетащите архив сюда или нажмите, чтобы выбрать
                </span>
                <span className="hint mt-1 block" id="dz-hint">
                  Поддерживаются .zip и .tar.gz
                </span>
              </>
            )}
          </button>
        )}

        {/* Скрытый input всегда в DOM: и клик по дропзоне, и повторный выбор. */}
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.tar.gz,.tgz"
          className="hidden"
          data-testid="import-file"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />

        {/* 2. Имя проекта (после файла, автозаполняется из имени архива). */}
        <div className="mt-5">
          <label className="label" htmlFor="import-name">
            Имя проекта{' '}
            <span style={{ color: 'var(--color-danger)' }} aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="import-name"
            className="input"
            data-testid="import-name"
            placeholder="Заполнится из имени файла"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            aria-describedby="import-name-hint"
          />
          <p className="hint mt-1.5" id="import-name-hint">
            {file
              ? 'Подставлено из имени архива — можно изменить.'
              : 'Подставится из имени архива — можно изменить.'}
          </p>
        </div>

        {error ? (
          <p
            className="mt-3 rounded-lg p-3 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            data-testid="import-error"
          >
            {error}
          </p>
        ) : null}

        <div
          className="mt-6 flex items-center justify-between gap-4 border-t pt-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <p className="hint" data-testid="import-disabled-reason">
            {footerHint}
          </p>
          <BusyButton
            type="submit"
            busy={busy}
            busyLabel="Импортируем…"
            data-testid="import-submit"
            disabled={!ready}
          >
            Импортировать
          </BusyButton>
        </div>
      </form>
    </AuxLayout>
  );
}
