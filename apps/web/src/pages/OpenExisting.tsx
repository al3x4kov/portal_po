import { Link } from 'react-router-dom';
import { AuxLayout } from '../components/AuxLayout';
import { useProjects } from '../api/hooks';
import { errorMessage } from '../api/client';

export function OpenExisting(): React.ReactElement {
  const { data: projects, isLoading, isError, error } = useProjects();

  return (
    <AuxLayout testid="open-page">
      <h1 className="text-xl font-bold">Открыть существующий проект</h1>
      <p className="mt-1 font-mono text-sm" style={{ color: 'var(--color-text-2)' }}>
        Projects/
      </p>

      {isLoading ? (
        <p
          className="mt-6 text-sm"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="open-loading"
        >
          Загрузка…
        </p>
      ) : isError ? (
        <p
          className="mt-6 rounded-lg p-3 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
          data-testid="open-error"
        >
          {errorMessage(error)}
        </p>
      ) : projects && projects.length > 0 ? (
        <ul
          className="card mt-6 divide-y"
          style={{ borderColor: 'var(--color-border)' }}
          data-testid="open-list"
        >
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/p/${encodeURIComponent(p.id)}`}
                data-testid={`open-project-${p.id}`}
                className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-[var(--color-surface-2)]"
              >
                <span className="flex items-center gap-3">
                  <span style={{ color: 'var(--color-primary)' }} aria-hidden="true">
                    🗀
                  </span>
                  <span>
                    <span className="block font-medium">{p.name}</span>
                    <span
                      className="block font-mono text-xs"
                      style={{ color: 'var(--color-text-3)' }}
                    >
                      {p.mainPath}
                    </span>
                  </span>
                </span>
                <span style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="card mt-6 p-6 text-center" data-testid="open-empty">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            В Projects/ пока нет проектов.
          </p>
          <Link to="/new" className="btn btn-primary mt-4 inline-flex">
            Создать новый
          </Link>
        </div>
      )}
    </AuxLayout>
  );
}
