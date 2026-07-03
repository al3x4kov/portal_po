import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SOURCE_PRESETS, type Requirement, type RequirementType } from '@po/core';
import { useProject, useRequirements, useCreateRequirement, useCreateLink, useDeleteRequirement } from '../api/hooks';
import { ApiError, errorMessage } from '../api/client';
import { useUiStore } from '../store/ui';
import { ancestorNamesOf, buildForest, childCountOf } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { matchesLabel } from '../lib/plural';
import { Sidebar } from '../components/Sidebar';
import { PathHeader } from '../components/PathHeader';
import { TreeToolbar } from '../components/TreeToolbar';
import { TreeTable } from '../components/TreeTable';
import { DescPanel } from '../components/DescPanel';
import { RequirementModal } from '../components/RequirementModal';
import { LinkModal } from '../components/LinkModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExportModal } from '../components/ExportModal';
import { ExportTasksModal } from '../components/ExportTasksModal';
import { GraphView } from '../components/GraphView/GraphView';

export function Main(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const graphView = useUiStore((s) => s.graphView);
  const treeMode = useUiStore((s) => s.treeMode);
  const search = useUiStore((s) => s.search);
  const expanded = useUiStore((s) => s.expanded);
  const toggleExpanded = useUiStore((s) => s.toggleExpanded);
  const criticalityFilter = useUiStore((s) => s.criticalityFilter);
  const implementationFilter = useUiStore((s) => s.implementationFilter);
  const sourceFilter = useUiStore((s) => s.sourceFilter);
  const setSearch = useUiStore((s) => s.setSearch);
  const resetFilters = useUiStore((s) => s.resetFilters);

  const deleteMut = useDeleteRequirement(id);
  const createReqMut = useCreateRequirement(id);
  const createLinkMut = useCreateLink(id);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [descReq, setDescReq] = useState<Requirement | null>(null);

  const requirements = reqQuery.data?.requirements ?? [];
  const broken = reqQuery.data?.broken ?? [];
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

  // T-517: slug → full Requirement map so RequirementModal can classify links by target type.
  const requirementsBySlug = useMemo(
    () => new Map<string, Requirement>(requirements.map((r) => [r.slug, r])),
    [requirements],
  );

  // FR-19: unique source values from all requirements + presets, sorted.
  const availableSources = useMemo(() => {
    const srcSet = new Set<string>(SOURCE_PRESETS);
    for (const r of requirements) {
      if (r.source) srcSet.add(r.source);
    }
    return [...srcSet].sort();
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
        sourceFilter,
      }),
    [functional, search, collapsed, expanded, criticalityFilter, implementationFilter, sourceFilter],
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
        sourceFilter,
      }),
    [nfr, search, collapsed, expanded, criticalityFilter, implementationFilter, sourceFilter],
  );

  const shown = fnVis.rows.length + nfrVis.rows.length;
  const total = fnVis.total + nfrVis.total;
  const matchCount = fnVis.matchCount + nfrVis.matchCount;
  const searchActive = search.trim().length > 0;
  const searchEmpty = searchActive && matchCount === 0;
  const filtersActive = criticalityFilter.size > 0 || implementationFilter.size > 0 || sourceFilter.size > 0;
  // UX-6: empty purely because of the criticality/implementation/source filters (no search).
  const filtersEmpty = !searchActive && filtersActive && shown === 0 && total > 0;

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

  // FR-21: open RequirementModal for a child requirement without preset criticality/implemented.
  // The modal will create the requirement and wire the CHILD_OF link via linkFrom/linkType.
  const handleAddChild = (req: Requirement): void => {
    openModal({
      kind: 'requirement',
      reqType: 'FUNCTION',
      linkFrom: req.slug,
      linkType: 'CHILD_OF',
    });
  };

  // Keep createReqMut and createLinkMut available (used elsewhere if needed).
  void createReqMut;
  void createLinkMut;

  return (
    <>
      <Sidebar
        projectId={id}
        activePage="requirements"
        onOpenExport={() => openModal({ kind: 'export' })}
        onOpenTasks={() => openModal({ kind: 'export-tasks' })}
      />
      <div
        className="flex min-h-screen flex-col"
        style={{ marginLeft: 'var(--sidebar-width)' }}
        data-testid="main-page"
      >
        <PathHeader
          name={projectQuery.data?.name ?? id}
          mainPath={projectQuery.data?.mainPath ?? ''}
        />

        {!reqQuery.isLoading && !reqQuery.isError ? (
          <TreeToolbar shown={shown} total={total} availableSources={availableSources} />
        ) : null}

        <main className={`w-full flex-1${graphView ? ' flex flex-col overflow-hidden' : ' px-4 py-5'}`}>
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
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
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
          ) : graphView ? (
            <GraphView projectId={id} />
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
                    style={{
                      background: 'var(--color-primary-soft)',
                      color: 'var(--color-primary)',
                    }}
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
                onAdd={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
                onEdit={onEdit}
                onLink={onLink}
                onAddNfr={onAddNfr}
                onAddChild={handleAddChild}
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
          className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t px-4 py-3"
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
            requirementsBySlug={requirementsBySlug}
            linkFrom={modal.linkFrom}
            linkType={modal.linkType}
            focusField={modal.focusField}
            noDefaultCriticality={!modal.requirement && modal.linkType === 'CHILD_OF'}
            onAddLink={
              modal.requirement
                ? (typeHint: RequirementType) => {
                    const req = modal.requirement!;
                    closeModal();
                    openModal({ kind: 'link', source: req, initialTypeFilter: typeHint });
                  }
                : undefined
            }
            onClose={closeModal}
          />
        ) : null}

        {modal?.kind === 'link' ? (
          <LinkModal
            projectId={id}
            source={modal.source}
            requirements={requirements}
            initialTypeFilter={modal.initialTypeFilter}
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

        {modal?.kind === 'export' ? (
          <ExportModal projectId={id} requirements={requirements} onClose={closeModal} />
        ) : null}

        {modal?.kind === 'export-tasks' ? (
          <ExportTasksModal projectId={id} requirements={requirements} onClose={closeModal} />
        ) : null}
      </div>
    </>
  );
}
