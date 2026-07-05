import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, FolderOpen } from 'lucide-react';
import { AuxLayout } from '../components/AuxLayout';
import { BusyButton } from '../components/BusyButton';
import { useCreateProject } from '../api/hooks';
import { ApiError, errorMessage } from '../api/client';
import { rememberRecentProject } from '../lib/recentProjects';
import type { ProjectSummary } from '../api/types';

export function NewProject(): React.ReactElement {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ProjectSummary | null>(null);
  const createMut = useCreateProject();

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      const project = await createMut.mutateAsync(name.trim());
      rememberRecentProject(project);
      setCreated(project);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'CONFLICT' || err.status === 409)) {
        setError('Проект с таким именем уже есть в Projects/. Выберите другое имя.');
      } else {
        setError(errorMessage(err));
      }
    }
  };

  return (
    <AuxLayout title="Новый проект" testid="newproject-page">
      {created ? (
        /* Состояние 2 — проект создан (success). */
        <div className="card p-5 text-center sm:p-6" role="status" data-testid="newproject-success">
          <span
            className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full"
            style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}
            aria-hidden="true"
          >
            <Check className="icon" />
          </span>
          <h2 className="text-lg font-bold">Проект «{created.name}» создан</h2>
          <p className="t2 mt-2 text-sm">Main Path:</p>
          <code
            className="mono mx-auto mt-1 block max-w-full truncate rounded px-3 py-2 text-xs"
            style={{ background: 'var(--color-surface-2)' }}
            title={created.mainPath}
            data-testid="newproject-mainpath"
          >
            {created.mainPath}
          </code>

          <div className="mt-6 flex flex-col items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="newproject-open"
              onClick={() => navigate(`/p/${encodeURIComponent(created.id)}`)}
            >
              <FolderOpen className="icon-sm" aria-hidden="true" />
              Открыть проект
            </button>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm font-medium"
              style={{ color: 'var(--color-primary)' }}
              data-testid="newproject-back"
            >
              <ArrowLeft className="icon-sm" aria-hidden="true" />К списку проектов
            </Link>
          </div>
        </div>
      ) : (
        /* Состояние 1 — форма. */
        <form className="card p-5 sm:p-6" onSubmit={submit} noValidate>
          <label className="label" htmlFor="pname">
            Имя проекта{' '}
            <span style={{ color: 'var(--color-danger)' }} aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="pname"
            className="input"
            data-testid="newproject-name"
            placeholder="Например: Портал поставщика"
            /* §2.2-1: единственное поле формы получает фокус сразу. */
            autoFocus
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-describedby="pname-hint"
          />
          {/* §2.2-2: подсказка о допустимых символах ДО сабмита. */}
          <p className="hint mt-1.5" id="pname-hint">
            Допустимы буквы, цифры, пробел, дефис и подчёркивание.
          </p>

          {/* Live-предпросмотр пути. */}
          <div
            className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2.5"
            style={{ background: 'var(--color-surface-2)' }}
            data-testid="newproject-path-preview"
          >
            <FolderOpen className="t3 icon-sm flex-none" aria-hidden="true" />
            <span className="t2 text-xs">Будет создан проект:</span>
            <code className="mono truncate text-xs font-semibold">
              Projects/{name.trim() || '<имя>'}
            </code>
          </div>

          {error ? (
            <p
              className="mt-3 rounded-lg p-3 text-sm"
              role="alert"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              data-testid="newproject-error"
            >
              {error}
            </p>
          ) : null}

          <div
            className="mt-6 flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-end"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
              Отмена
            </button>
            <BusyButton
              type="submit"
              busy={createMut.isPending}
              busyLabel="Создаём…"
              data-testid="newproject-submit"
              disabled={name.trim().length === 0}
            >
              Создать проект
            </BusyButton>
          </div>
        </form>
      )}
    </AuxLayout>
  );
}
