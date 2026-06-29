import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuxLayout } from '../components/AuxLayout';
import { useCreateProject } from '../api/hooks';
import { ApiError, errorMessage } from '../api/client';
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
      setCreated(project);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'CONFLICT' || err.status === 409)) {
        setError('Каталог с таким именем уже есть в Projects/. Выберите другое имя.');
      } else {
        setError(errorMessage(err));
      }
    }
  };

  return (
    <AuxLayout testid="newproject-page">
      <div className="card p-6">
        <h1 className="text-xl font-bold">Новый проект</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-2)' }}>
          Будет создан каталог в Projects/. Если каталог Projects/ отсутствует — он будет воссоздан
          автоматически.
        </p>

        {created ? (
          <div className="mt-6 space-y-4" data-testid="newproject-success">
            <div
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}
            >
              Проект «{created.name}» создан.
            </div>
            <div>
              <div className="label">Main Path</div>
              <div className="input font-mono text-xs" data-testid="newproject-mainpath">
                {created.mainPath}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary w-full"
              data-testid="newproject-open"
              onClick={() => navigate(`/p/${encodeURIComponent(created.id)}`)}
            >
              Открыть проект
            </button>
          </div>
        ) : (
          <form className="mt-6 space-y-2" onSubmit={submit} noValidate>
            <label className="label" htmlFor="pname">
              Имя проекта
            </label>
            <input
              id="pname"
              className="input"
              data-testid="newproject-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              aria-describedby="pname-hint"
            />
            <p
              id="pname-hint"
              className="font-mono text-xs"
              style={{ color: 'var(--color-text-3)' }}
            >
              Будет создан путь: Projects/{name.trim() || '…'}
            </p>

            {error ? (
              <p
                className="rounded-lg p-2 text-sm"
                role="alert"
                style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
                data-testid="newproject-error"
              >
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-3 pt-3">
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
                Отменить
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                data-testid="newproject-submit"
                disabled={createMut.isPending || name.trim().length === 0}
              >
                Создать проект
              </button>
            </div>
          </form>
        )}
      </div>
    </AuxLayout>
  );
}
