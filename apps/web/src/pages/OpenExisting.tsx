import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AuxLayout } from '../components/AuxLayout';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useDeleteProject, useProjects } from '../api/hooks';
import { errorMessage } from '../api/client';
import type { ProjectSummary } from '../api/types';

export function OpenExisting(): React.ReactElement {
  const { data: projects, isLoading, isError, error } = useProjects();
  // B1 (todo_16): project pending delete confirmation (null = no dialog).
  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null);
  const deleteProject = useDeleteProject();

  const confirmDelete = (): void => {
    if (!toDelete) return;
    deleteProject.mutate(
      { id: toDelete.id, name: toDelete.name },
      // Close the dialog in both outcomes: success removes the row from the
      // list, failure surfaces a toast (spec: «диалог закрыт»).
      { onSettled: () => setToDelete(null) },
    );
  };

  return (
    <AuxLayout testid="open-page">
      {/* Breakout: AuxLayout <main> is max-w-lg; project paths can be long, so this
          page widens itself up to max-w-4xl (56rem) while staying centered. */}
      <div
        className="relative left-1/2 w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2"
        data-testid="open-container"
      >
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
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
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
              <li key={p.id} className="flex items-stretch">
                <Link
                  to={`/p/${encodeURIComponent(p.id)}`}
                  data-testid={`open-project-${p.id}`}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 p-4 transition-colors hover:bg-[var(--color-surface-2)]"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      className="shrink-0"
                      style={{ color: 'var(--color-primary)' }}
                      aria-hidden="true"
                    >
                      🗀
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* Name is always fully visible (wraps if needed)… */}
                      <span className="block break-words font-medium">{p.name}</span>
                      {/* …the path is secondary: truncated, full value in title. */}
                      <span
                        className="block truncate font-mono text-xs"
                        style={{ color: 'var(--color-text-3)' }}
                        title={p.mainPath}
                        data-testid={`open-project-path-${p.id}`}
                      >
                        {p.mainPath}
                      </span>
                    </span>
                  </span>
                  <span
                    className="shrink-0"
                    style={{ color: 'var(--color-text-3)' }}
                    aria-hidden="true"
                  >
                    →
                  </span>
                </Link>
                {/* B1: delete lives OUTSIDE the Link (no nested interactive
                    elements), so clicking it never opens the project. */}
                <button
                  type="button"
                  className="mr-2 shrink-0 self-center rounded-lg p-2 transition-colors hover:bg-[var(--color-danger-bg)]"
                  style={{ color: 'var(--color-danger-fg)' }}
                  aria-label={`Удалить проект «${p.name}»`}
                  title="Удалить проект"
                  data-testid={`project-delete-${p.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setToDelete(p);
                  }}
                >
                  <span aria-hidden="true">🗑</span>
                </button>
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
      </div>

      {toDelete ? (
        <ConfirmDialog
          title="Удалить проект"
          message={`Проект „${toDelete.name}“ и все его файлы будут удалены с диска. Действие необратимо.`}
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          danger
          busy={deleteProject.isPending}
          testid="project-delete-dialog"
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      ) : null}
    </AuxLayout>
  );
}
