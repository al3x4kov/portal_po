import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, Search, Trash2, TriangleAlert } from 'lucide-react';
import { AuxLayout } from '../components/AuxLayout';
import { BusyButton } from '../components/BusyButton';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useDeleteProject, useProjects } from '../api/hooks';
import { errorMessage } from '../api/client';
import { forgetRecentProject, rememberRecentProject } from '../lib/recentProjects';
import type { ProjectSummary } from '../api/types';

/** The filter field appears only when the list is long (mockup: 8+ projects). */
const FILTER_THRESHOLD = 8;

/**
 * §2.4-1: deleting a project is confirmed by typing its exact name (friction
 * level 2) — the danger button stays disabled until the input matches.
 * §2.4-4: a failed DELETE shows the error INSIDE the dialog and keeps it open.
 */
function DeleteProjectDialog({
  project,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  project: ProjectSummary;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [confirmName, setConfirmName] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The destructive button is guarded by the name check, so the input is the
  // safe initial focus target.
  useFocusTrap(dialogRef, { initialFocus: inputRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const match = confirmName.trim() === project.name;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center p-4"
      style={{ background: 'rgba(15,23,42,.5)' }}
      data-testid="project-delete-dialog-overlay"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        className="card w-full max-w-md p-5"
        data-testid="project-delete-dialog"
      >
        <div className="flex items-start gap-3">
          <span
            className="grid h-9 w-9 flex-none place-items-center rounded-full"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            aria-hidden="true"
          >
            <TriangleAlert className="icon-sm" />
          </span>
          <div className="min-w-0">
            <h2 id="delete-project-title" className="font-bold">
              Удалить проект «{project.name}»?
            </h2>
            <p className="t2 mt-1 text-sm" data-testid="project-delete-dialog-message">
              Папка проекта и все .md-файлы требований будут удалены с диска безвозвратно.
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="delete-confirm-name">
            Введите имя проекта для подтверждения
          </label>
          <input
            id="delete-confirm-name"
            ref={inputRef}
            className="input"
            placeholder={project.name}
            autoComplete="off"
            data-testid="delete-confirm-input"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            disabled={busy}
          />
        </div>

        {error ? (
          <div
            className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            data-testid="delete-error"
          >
            <TriangleAlert className="icon-sm mt-0.5 flex-none" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="project-delete-dialog-cancel"
            onClick={onCancel}
          >
            Отменить
          </button>
          <BusyButton
            className="btn btn-danger"
            busy={busy}
            busyLabel="Удаляем…"
            data-testid="project-delete-dialog-confirm"
            disabled={!match}
            onClick={onConfirm}
          >
            {error ? 'Повторить удаление' : 'Удалить проект'}
          </BusyButton>
        </div>
        <p className="hint mt-2 text-right">Кнопка активируется при точном совпадении имени</p>
      </div>
    </div>
  );
}

export function OpenExisting(): React.ReactElement {
  const { data: projects, isLoading, isError, error } = useProjects();
  const [filter, setFilter] = useState('');
  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteProject = useDeleteProject();

  const confirmDelete = (): void => {
    if (!toDelete) return;
    setDeleteError(null);
    deleteProject.mutate(
      { id: toDelete.id, name: toDelete.name },
      {
        onSuccess: () => {
          forgetRecentProject(toDelete.id);
          setToDelete(null);
        },
        // §2.4-4: the dialog stays open, the error is shown inside it.
        onError: (err) => setDeleteError(errorMessage(err)),
      },
    );
  };

  const query = filter.trim().toLowerCase();
  const filtered = (projects ?? []).filter(
    (p) => query.length === 0 || `${p.name} ${p.mainPath}`.toLowerCase().includes(query),
  );

  return (
    <AuxLayout title="Открыть существующий проект" testid="open-page">
      {isLoading ? (
        <p className="t3 mt-2 text-sm" data-testid="open-loading">
          Загрузка…
        </p>
      ) : isError ? (
        <p
          className="rounded-lg p-3 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="open-error"
        >
          {errorMessage(error)}
        </p>
      ) : projects && projects.length > 0 ? (
        <>
          {/* §2.4-2: фильтр над списком (при 8+ проектах). */}
          {projects.length >= FILTER_THRESHOLD ? (
            <div className="relative mb-4">
              <Search
                className="t3 icon-sm pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <label htmlFor="project-filter" className="sr-only">
                Найти проект
              </label>
              <input
                id="project-filter"
                className="input pl-9"
                placeholder="Найти проект…"
                autoComplete="off"
                data-testid="project-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          ) : null}

          {filtered.length > 0 ? (
            <ul className="card overflow-hidden" role="list" data-testid="open-list">
              {filtered.map((p, i) => (
                <li
                  key={p.id}
                  className={`row flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)]${i > 0 ? ' border-t' : ''}`}
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <FolderOpen
                    className="icon flex-none"
                    style={{ color: 'var(--color-primary)' }}
                    aria-hidden="true"
                  />
                  <Link
                    to={`/p/${encodeURIComponent(p.id)}`}
                    className="min-w-0 flex-1"
                    data-testid={`open-project-${p.id}`}
                    onClick={() => rememberRecentProject(p)}
                  >
                    {/* Имя видно целиком (переносится)… */}
                    <span className="block break-words text-sm font-semibold">{p.name}</span>
                    {/* …путь вторичен: усечён, полное значение в title. */}
                    <span
                      className="mono t3 block truncate text-min"
                      title={p.mainPath}
                      data-testid={`open-project-path-${p.id}`}
                    >
                      {p.mainPath}
                    </span>
                  </Link>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm row-actions flex-none"
                    aria-label={`Удалить проект «${p.name}»`}
                    title="Удалить проект"
                    data-testid={`project-delete-${p.id}`}
                    onClick={() => {
                      setDeleteError(null);
                      setToDelete(p);
                    }}
                  >
                    <Trash2 className="icon-sm" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint mt-2" data-testid="open-filter-empty">
              Ничего не найдено по запросу «{filter.trim()}».
            </p>
          )}
        </>
      ) : (
        <div className="card p-6 text-center" data-testid="open-empty">
          <p className="t2 text-sm">В Projects/ пока нет проектов.</p>
          <Link to="/new" className="btn btn-primary mt-4 inline-flex">
            Создать новый
          </Link>
        </div>
      )}

      {toDelete ? (
        <DeleteProjectDialog
          project={toDelete}
          busy={deleteProject.isPending}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => {
            setToDelete(null);
            setDeleteError(null);
          }}
        />
      ) : null}
    </AuxLayout>
  );
}
