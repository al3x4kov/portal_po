import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuxLayout } from '../components/AuxLayout';
import { useImportProject } from '../api/hooks';
import { errorMessage } from '../api/client';

const ACCEPTED = /\.(zip|tar\.gz|tgz)$/i;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function Import(): React.ReactElement {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importMut = useImportProject();

  const pickFile = (f: File | null): void => {
    setError(null);
    if (f && !ACCEPTED.test(f.name)) {
      setFile(null);
      setError('Неподдерживаемый формат. Допустимы .zip или .tar.gz.');
      return;
    }
    setFile(f);
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
      navigate(`/p/${encodeURIComponent(project.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuxLayout testid="import-page">
      <div className="card p-6">
        <h1 className="text-xl font-bold">Импорт проекта</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-2)' }}>
          Загрузите архив .zip или .tar.gz. Содержимое будет проверено и распаковано в новый
          каталог.
        </p>

        <form className="mt-6 space-y-5" onSubmit={submit} noValidate>
          <div>
            <label className="label" htmlFor="import-name">
              Имя проекта (каталог)
            </label>
            <input
              id="import-name"
              className="input"
              data-testid="import-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <span className="label">Архив проекта</span>
            <div
              className="grid place-items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center"
              style={{ borderColor: 'var(--color-border)' }}
              data-testid="import-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files[0] ?? null);
              }}
            >
              <span
                className="text-2xl"
                style={{ color: 'var(--color-text-3)' }}
                aria-hidden="true"
              >
                ↓
              </span>
              <span className="text-sm font-medium">Перетащите архив сюда</span>
              <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                или
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => fileRef.current?.click()}
              >
                Выбрать файл
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,.tar.gz,.tgz"
                className="hidden"
                data-testid="import-file"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {file ? (
              <div
                className="mt-3 flex items-center justify-between rounded-lg p-3"
                style={{ background: 'var(--color-surface-2)' }}
                data-testid="import-file-name"
              >
                <span className="font-mono text-xs">
                  {file.name} · {formatSize(file.size)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost text-sm"
                  aria-label="Убрать файл"
                  onClick={() => pickFile(null)}
                >
                  ✕
                </button>
              </div>
            ) : null}
          </div>

          {error ? (
            <p
              className="rounded-lg p-3 text-sm"
              role="alert"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
              data-testid="import-error"
            >
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-3">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
              Отменить
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="import-submit"
              disabled={importMut.isPending || name.trim().length === 0 || !file}
            >
              Импортировать
            </button>
          </div>
        </form>
      </div>
    </AuxLayout>
  );
}
