import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Requirement } from '@po/core';
import { useProject, useRequirements, useDeleteRequirement } from '../api/hooks';
import { projectsApi } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useUiStore } from '../store/ui';
import { ancestorNamesOf, buildForest, childCountOf } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { matchesLabel } from '../lib/plural';
import { PathHeader } from '../components/PathHeader';
import { TreeToolbar } from '../components/TreeToolbar';
import { TreeTable } from '../components/TreeTable';
import { DescPanel } from '../components/DescPanel';
import { RequirementModal } from '../components/RequirementModal';
import { LinkModal } from '../components/LinkModal';
import { ConfirmDialog } from '../components/ConfirmDialog';

/** Export formats offered in the footer (archives + Excel), UX-8. */
type ExportFormat = 'xlsx' | 'zip' | 'targz';

export function Main(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const treeMode = useUiStore((s) => s.treeMode);
  const search = useUiStore((s) => s.search);
  const expanded = useUiStore((s) => s.expanded);
  const toggleExpanded = useUiStore((s) => s.toggleExpanded);
  const criticalityFilter = useUiStore((s) => s.criticalityFilter);
  const implementationFilter = useUiStore((s) => s.implementationFilter);
  const setSearch = useUiStore((s) => s.setSearch);
  const resetFilters = useUiStore((s) => s.resetFilters);

  const deleteMut = useDeleteRequirement(id);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [descReq, setDescReq] = useState<Requirement | null>(null);

  const requirements = reqQuery.data?.requirements ?? [];
  const broken = reqQuery.data?.broken ?? [];
  const incompleteSet = useMemo(
    () => new Set(reqQuery.data?.incomplete ?? []),
    [reqQuery.data?.incomplete],
  );
  const functional = requirements.filter((r) => r.type === 'FUNCTION');
  const nfr = requirements.filter((r) => r.type === 'NFR');
  const collapsed = treeMode === 'collapse';

  // Project-wide slug → name map so link chips can show targets by name (slug is
  // unique across both types, so a single map is unambiguous).
  const nameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of requirements) m.set(r.slug, r.name);
    return m;
  }, [requirements]);

  const fnVis = useMemo(
    () =>
      computeVisibleRows({
        forest: buildForest(functional),
        search,
        collapsed,
        expanded,
        criticalityFilter,
        implementationFilter,
      }),
    [functional, search, collapsed, expanded, criticalityFilter, implementationFilter],
  );
  const nfrVis = useMemo(
    () =>
      computeVisibleRows({
        forest: buildForest(nfr),
        search,
        collapsed,
        expanded,
        criticalityFilter,
        implementationFilter,
      }),
    [nfr, search, collapsed, expanded, criticalityFilter, implementationFilter],
  );

  const shown = fnVis.rows.length + nfrVis.rows.length;
  const total = fnVis.total + nfrVis.total;
  const matchCount = fnVis.matchCount + nfrVis.matchCount;
  const searchActive = search.trim().length > 0;
  const searchEmpty = searchActive && matchCount === 0;
  const filtersActive = criticalityFilter.size > 0 || implementationFilter.size > 0;
  // UX-6: empty purely because of the criticality/implementation filters (no search).
  const filtersEmpty = !searchActive && filtersActive && shown === 0 && total > 0;

  const onExport = async (format: ExportFormat): Promise<void> => {
    if (exporting) return; // one export at a time (buttons are disabled meanwhile)
    setExportError(null);
    setExporting(format);
    try {
      const { blob, filename } =
        format === 'xlsx' ? await projectsApi.exportXlsx(id) : await projectsApi.export(id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const onEdit = (req: Requirement): void => {
    setDescReq(null);
    openModal({ kind: 'requirement', reqType: req.type, requirement: req });
  };
  const onLink = (req: Requirement): void => openModal({ kind: 'link', source: req });
  // T4: create an NFR pre-linked to this functional requirement (ФТ BLOCKED_BY НФТ).
  const onAddNfr = (req: Requirement): void =>
    openModal({ kind: 'requirement', reqType: 'NFR', linkFrom: req.slug, linkType: 'BLOCKED_BY' });
  const onDelete = (req: Requirement): void => {
    setDescReq(null);
    setDeleteError(null);
    openModal({ kind: 'delete', requirement: req });
  };

  return (
    <div className="flex min-h-screen flex-col" data-testid="main-page">
      <PathHeader
        name={projectQuery.data?.name ?? id}
        mainPath={projectQuery.data?.mainPath ?? ''}
      />

      {!reqQuery.isLoading && !reqQuery.isError ? (
        <TreeToolbar shown={shown} total={total} />
      ) : null}

      <main className="w-full flex-1 px-4 py-5">
        {!reqQuery.isLoading && !reqQuery.isError && broken.length > 0 ? (
          <section
            className="card mb-5 p-4"
            role="alert"
            style={{ borderColor: 'var(--color-danger)' }}
            data-testid="broken-panel"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden="true">⚠</span>
              <h2 className="font-bold" style={{ color: 'var(--color-danger)' }}>
                Битые файлы требований ({broken.length})
              </h2>
            </div>
            <p className="mt-1 text-sm" style={{ color: 'var(--color-text-2)' }}>
              Эти файлы не удалось разобрать — они не показаны в дереве. Исправьте их вручную в
              каталоге проекта.
            </p>
            <ul className="mt-3 space-y-2">
              {broken.map((b) => (
                <li
                  key={b.file}
                  className="rounded-lg p-2.5 text-sm"
                  style={{ background: 'var(--color-danger-bg)' }}
                  data-testid="broken-item"
                >
                  <span
                    className="font-mono font-semibold"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    {b.file}
                  </span>
                  <span className="ml-2" style={{ color: 'var(--color-text-2)' }}>
                    {b.error}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {reqQuery.isLoading ? (
          <p data-testid="main-loading" style={{ color: 'var(--color-text-3)' }}>
            Загрузка требований…
          </p>
        ) : reqQuery.isError ? (
          <p
            className="rounded-lg p-3 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            data-testid="main-error"
          >
            {errorMessage(reqQuery.error)}
          </p>
        ) : searchEmpty ? (
          <section
            className="card flex flex-col items-center px-6 py-14 text-center"
            data-testid="search-empty"
          >
            <div
              className="mb-4 grid place-items-center rounded-full"
              style={{ width: 56, height: 56, background: 'var(--color-surface-2)' }}
              aria-hidden="true"
            >
              <svg
                width="26"
                height="26"
                fill="none"
                stroke="var(--color-text-3)"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <p className="font-semibold">Ничего не найдено по запросу «{search.trim()}»</p>
            <p className="mt-1 max-w-sm text-sm" style={{ color: 'var(--color-text-3)' }}>
              Проверьте написание или очистите поиск, чтобы вернуть полное дерево требований.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className="btn btn-secondary text-sm"
                data-testid="search-clear"
                onClick={() => setSearch('')}
              >
                Очистить поиск
              </button>
              {filtersActive ? (
                <button
                  type="button"
                  className="btn btn-secondary text-sm"
                  data-testid="filters-reset"
                  onClick={resetFilters}
                >
                  Сбросить фильтры
                </button>
              ) : null}
            </div>
          </section>
        ) : filtersEmpty ? (
          <section
            className="card flex flex-col items-center px-6 py-14 text-center"
            data-testid="filters-empty"
          >
            <div
              className="mb-4 grid place-items-center rounded-full"
              style={{ width: 56, height: 56, background: 'var(--color-surface-2)' }}
              aria-hidden="true"
            >
              <svg
                width="26"
                height="26"
                fill="none"
                stroke="var(--color-text-3)"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
            </div>
            <p className="font-semibold">Нет требований под выбранные фильтры</p>
            <p className="mt-1 max-w-sm text-sm" style={{ color: 'var(--color-text-3)' }}>
              Ослабьте условия или сбросьте все фильтры, чтобы вернуть полное дерево требований.
            </p>
            <button
              type="button"
              className="btn btn-secondary mt-4 text-sm"
              data-testid="filters-reset"
              onClick={resetFilters}
            >
              Сбросить фильтры
            </button>
          </section>
        ) : (
          <>
            {searchActive ? (
              <p
                className="mb-3 text-xs"
                style={{ color: 'var(--color-text-3)' }}
                data-testid="search-count"
              >
                {matchesLabel(matchCount)} · показаны предки
              </p>
            ) : null}
            {filtersActive ? (
              <div
                className="mb-3 flex flex-wrap items-center gap-2 text-xs"
                data-testid="filters-applied"
              >
                <span
                  className="badge"
                  style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
                >
                  Фильтры применены
                </span>
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-0.5 text-xs"
                  data-testid="filters-reset-all"
                  onClick={resetFilters}
                >
                  Сбросить все фильтры
                </button>
              </div>
            ) : null}
            <TreeTable
              title="Функциональные требования"
              addLabel="+ Функция"
              testidPrefix="function"
              count={functional.length}
              rows={fnVis.rows}
              nameBySlug={nameBySlug}
              incompleteSet={incompleteSet}
              onAdd={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
              onEdit={onEdit}
              onLink={onLink}
              onAddNfr={onAddNfr}
              onDelete={onDelete}
              onDescExpand={setDescReq}
              onExpandNode={toggleExpanded}
              onToggleNode={toggleExpanded}
              interactiveChevron={collapsed}
            />
            <TreeTable
              title="Нефункциональные требования"
              addLabel="+ НФТ"
              testidPrefix="nfr"
              count={nfr.length}
              rows={nfrVis.rows}
              nameBySlug={nameBySlug}
              incompleteSet={incompleteSet}
              onAdd={() => openModal({ kind: 'requirement', reqType: 'NFR' })}
              onEdit={onEdit}
              onLink={onLink}
              onDelete={onDelete}
              onDescExpand={setDescReq}
              onExpandNode={toggleExpanded}
              onToggleNode={toggleExpanded}
              interactiveChevron={collapsed}
            />
          </>
        )}
      </main>

      <footer
        className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        data-testid="main-footer"
      >
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="footer-add-function"
            onClick={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
          >
            + Функция
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="footer-add-nfr"
            onClick={() => openModal({ kind: 'requirement', reqType: 'NFR' })}
          >
            + НФТ
          </button>
        </div>
        <div className="flex items-center gap-2">
          {exportError ? (
            <span
              className="text-xs"
              role="alert"
              style={{ color: 'var(--color-danger)' }}
              data-testid="export-error"
            >
              {exportError}
            </span>
          ) : null}
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Экспорт:
          </span>
          {exporting ? (
            <span
              className="text-xs"
              role="status"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="export-busy"
            >
              Экспорт…
            </span>
          ) : null}
          {/* UX-8: xlsx now shares the archives' fetch/blob path — errors surface in
              `export-error` and all three buttons are disabled while exporting. */}
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="export-xlsx"
            disabled={exporting !== null}
            onClick={() => void onExport('xlsx')}
          >
            Excel (.xlsx)
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="export-zip"
            disabled={exporting !== null}
            onClick={() => void onExport('zip')}
          >
            .zip
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="export-targz"
            disabled={exporting !== null}
            onClick={() => void onExport('targz')}
          >
            .tar.gz
          </button>
        </div>
      </footer>

      {descReq ? (
        <DescPanel
          requirement={descReq}
          path={ancestorNamesOf(descReq, requirements)}
          onClose={() => setDescReq(null)}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}

      {modal?.kind === 'requirement' ? (
        <RequirementModal
          projectId={id}
          reqType={modal.reqType}
          requirement={modal.requirement}
          nameBySlug={nameBySlug}
          linkFrom={modal.linkFrom}
          linkType={modal.linkType}
          onClose={closeModal}
        />
      ) : null}

      {modal?.kind === 'link' ? (
        <LinkModal
          projectId={id}
          source={modal.source}
          requirements={requirements}
          onClose={closeModal}
        />
      ) : null}

      {modal?.kind === 'delete'
        ? (() => {
            const req = modal.requirement;
            const children = childCountOf(req);
            const note =
              children > 0
                ? {
                    tone: 'danger' as const,
                    text: `У требования есть ${children} дочерних элемент(ов). Сначала удалите или перепривяжите их.`,
                  }
                : {
                    tone: 'warning' as const,
                    text: 'У требования нет дочерних элементов — удаление безопасно.',
                  };
            return (
              <ConfirmDialog
                testid="delete-dialog"
                danger
                title="Точно удалить требование?"
                message={`«${req.name}» будет удалено безвозвратно. Все связи с другими требованиями также будут удалены.`}
                note={note}
                error={deleteError}
                confirmLabel="Удалить"
                busy={deleteMut.isPending}
                confirmDisabled={children > 0}
                onCancel={closeModal}
                onConfirm={async () => {
                  setDeleteError(null);
                  try {
                    await deleteMut.mutateAsync(req.slug);
                    closeModal();
                  } catch (err) {
                    if (err instanceof ApiError && err.code === 'HAS_CHILDREN') {
                      setDeleteError('Нельзя удалить требование с дочерними элементами.');
                    } else {
                      setDeleteError(errorMessage(err));
                    }
                  }
                }}
              />
            );
          })()
        : null}
    </div>
  );
}
