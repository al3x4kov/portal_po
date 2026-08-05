import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import {
  countAiPendingReview,
  SOURCE_PRESETS,
  type Requirement,
  type RequirementType,
} from '@po/core';
import {
  useProject,
  useRequirements,
  useCreateRequirement,
  useCreateLink,
  useDeleteRequirement,
  useDictionaries,
} from '../api/hooks';
import { ApiError, errorMessage } from '../api/client';
import { useUiStore } from '../store/ui';
import { ancestorNamesOf, buildForest, descendantCountOf } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { sourceNamesOf } from '../lib/sources';
import { matchesLabel, requirementsLabel } from '../lib/plural';
import { useStructureMove } from '../lib/useStructureMove';
import { Sidebar } from '../components/Sidebar';
import { StructureBar } from '../components/StructureBar';
import { PathHeader } from '../components/PathHeader';
import { TreeToolbar } from '../components/TreeToolbar';
import { TreeTable } from '../components/TreeTable';
import { SourceSlice } from '../components/SourceSlice';
import { DescPanel } from '../components/DescPanel';
import { RequirementModal } from '../components/RequirementModal';
import { LinkModal } from '../components/LinkModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GraphView } from '../components/GraphView/GraphView';
import { AiImportModal } from '../components/AiImportModal';
import { AiBacklogImportModal } from '../components/AiBacklogImportModal';

export function Main(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const graphView = useUiStore((s) => s.graphView);
  const mainView = useUiStore((s) => s.mainView);
  const setMainView = useUiStore((s) => s.setMainView);
  const treeMode = useUiStore((s) => s.treeMode);
  const search = useUiStore((s) => s.search);
  const expanded = useUiStore((s) => s.expanded);
  const toggleExpanded = useUiStore((s) => s.toggleExpanded);
  const collapsedOverrides = useUiStore((s) => s.collapsedOverrides);
  const toggleCollapsedOverride = useUiStore((s) => s.toggleCollapsedOverride);
  const criticalityFilter = useUiStore((s) => s.criticalityFilter);
  const implementationFilter = useUiStore((s) => s.implementationFilter);
  const sourceFilter = useUiStore((s) => s.sourceFilter);
  const aiPendingFilter = useUiStore((s) => s.aiPendingFilter);
  const setSearch = useUiStore((s) => s.setSearch);
  const resetFilters = useUiStore((s) => s.resetFilters);

  const structure = useStructureMove(id, reqQuery.data?.requirements ?? []);
  const deleteMut = useDeleteRequirement(id);
  const createReqMut = useCreateRequirement(id);
  const createLinkMut = useCreateLink(id);
  const dictionariesQuery = useDictionaries(id);
  const priorities = dictionariesQuery.data?.priorities ?? [];
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [descReq, setDescReq] = useState<Requirement | null>(null);
  // Task 11: AI-import modal lives outside the ui-store modal union — it must
  // survive job polling regardless of other modals opening from the tree.
  const [aiImportOpen, setAiImportOpen] = useState(false);
  // todo_22 (T-305): the backlog import modal follows the same pattern.
  const [aiBacklogOpen, setAiBacklogOpen] = useState(false);

  const requirements = reqQuery.data?.requirements ?? [];
  const broken = reqQuery.data?.broken ?? [];
  const functional = requirements.filter((r) => r.type === 'FUNCTION');
  const nfr = requirements.filter((r) => r.type === 'NFR');
  const collapsed = treeMode === 'collapse';
  // task23: one chevron handler for both modes — collapse mode toggles the
  // `expanded` set, expand-all mode toggles a point collapse override.
  const toggleNode = collapsed ? toggleExpanded : toggleCollapsedOverride;

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

  // FR-19: unique source names across all requirements + presets, sorted.
  // Names come from `sources[]` (todo_19), falling back to the legacy scalar
  // `source` for not-yet-migrated requirements (see sourceNamesOf).
  const availableSources = useMemo(() => {
    const srcSet = new Set<string>(SOURCE_PRESETS);
    for (const r of requirements) {
      for (const name of sourceNamesOf(r)) srcSet.add(name);
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
        collapsedOverrides,
        criticalityFilter,
        implementationFilter,
        sourceFilter,
        aiPendingOnly: aiPendingFilter,
      }),
    [
      functional,
      search,
      collapsed,
      expanded,
      collapsedOverrides,
      criticalityFilter,
      implementationFilter,
      sourceFilter,
      aiPendingFilter,
    ],
  );
  const nfrVis = useMemo(
    () =>
      computeVisibleRows({
        forest: buildForest(nfr),
        search,
        collapsed,
        expanded,
        collapsedOverrides,
        criticalityFilter,
        implementationFilter,
        sourceFilter,
        aiPendingOnly: aiPendingFilter,
      }),
    [
      nfr,
      search,
      collapsed,
      expanded,
      collapsedOverrides,
      criticalityFilter,
      implementationFilter,
      sourceFilter,
      aiPendingFilter,
    ],
  );

  const shown = fnVis.rows.length + nfrVis.rows.length;
  const total = fnVis.total + nfrVis.total;
  const matchCount = fnVis.matchCount + nfrVis.matchCount;
  const searchActive = search.trim().length > 0;
  const searchEmpty = searchActive && matchCount === 0;
  const filtersActive =
    criticalityFilter.size > 0 ||
    implementationFilter.size > 0 ||
    sourceFilter.size > 0 ||
    aiPendingFilter;
  // task26: счётчик «Не проверено» — по всему проекту (ФТ + НФТ), независимо от
  // активных фильтров; правило считает ядро (countAiPendingReview).
  const aiPendingCount = useMemo(() => countAiPendingReview(requirements), [requirements]);
  // UX-6: empty purely because of the criticality/implementation/source filters (no search).
  const filtersEmpty = !searchActive && filtersActive && shown === 0 && total > 0;

  const onEdit = (req: Requirement): void => {
    setDescReq(null);
    openModal({ kind: 'requirement', reqType: req.type, requirement: req });
  };
  const onLink = (req: Requirement): void => openModal({ kind: 'link', source: req });
  // T3 (§2.5.4): «+ Описание» в пустой ячейке сразу открывает редактирование описания.
  const onAddDesc = (req: Requirement): void =>
    openModal({
      kind: 'requirement',
      reqType: req.type,
      requirement: req,
      focusField: 'description',
    });
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
        onOpenExport={() => navigate(`/p/${id}/export`)}
        onOpenTasks={() => navigate(`/p/${id}/generate`)}
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
          <TreeToolbar
            shown={shown}
            total={total}
            availableSources={availableSources}
            aiPendingCount={aiPendingCount}
          />
        ) : null}

        <main
          className={`w-full flex-1${graphView ? ' flex flex-col overflow-hidden' : ' px-4 py-5'}`}
        >
          {!reqQuery.isLoading && !reqQuery.isError && broken.length > 0 ? (
            <section
              className="card mb-5 p-4"
              role="alert"
              style={{ borderColor: 'var(--color-danger)' }}
              data-testid="broken-panel"
            >
              <div className="flex items-center gap-2">
                <TriangleAlert
                  className="icon"
                  style={{ color: 'var(--color-danger)' }}
                  aria-hidden="true"
                />
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
              {/* todo_19 (T-208): Дерево ↔ «По источникам» срез. */}
              <div
                className="mb-3 inline-flex rounded-lg p-1"
                style={{ background: 'var(--color-surface-2)' }}
                role="tablist"
                aria-label="Режим главного экрана"
                data-testid="main-view-toggle"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mainView === 'tree'}
                  className={`rounded-md px-3 py-1.5 text-sm ${mainView === 'tree' ? 'surface font-semibold shadow-sm' : ''}`}
                  style={mainView === 'tree' ? undefined : { color: 'var(--color-text-2)' }}
                  data-testid="main-view-tree"
                  onClick={() => setMainView('tree')}
                >
                  Дерево
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mainView === 'sources'}
                  className={`rounded-md px-3 py-1.5 text-sm ${mainView === 'sources' ? 'surface font-semibold shadow-sm' : ''}`}
                  style={mainView === 'sources' ? undefined : { color: 'var(--color-text-2)' }}
                  data-testid="main-view-sources"
                  onClick={() => setMainView('sources')}
                >
                  По источникам
                </button>
              </div>

              {mainView === 'sources' ? (
                <SourceSlice requirements={requirements} priorities={priorities} onOpen={onEdit} />
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
                    priorities={priorities}
                    onAdd={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
                    onEdit={onEdit}
                    onLink={onLink}
                    onAddNfr={onAddNfr}
                    onAddChild={handleAddChild}
                    onDelete={onDelete}
                    onDescExpand={setDescReq}
                    onAddDesc={onAddDesc}
                    onExpandNode={toggleNode}
                    onToggleNode={toggleNode}
                    structureMode={structure.active}
                    selectedSlug={structure.selectedSlug}
                    onSelectRow={structure.select}
                    moveOptions={structure.options}
                    onMoveOp={structure.applyOp}
                    draggingSlug={structure.draggingSlug}
                    onDragStartRow={structure.startDrag}
                    onDragEndRow={structure.endDrag}
                    dropReasonFor={structure.dropReasonFor}
                    onDropOnRow={structure.dropOn}
                    failedSlug={structure.failedSlug}
                  />
                  <TreeTable
                    title="Нефункциональные требования"
                    addLabel="+ НФТ"
                    testidPrefix="nfr"
                    count={nfr.length}
                    rows={nfrVis.rows}
                    nameBySlug={nameBySlug}
                    priorities={priorities}
                    onAdd={() => openModal({ kind: 'requirement', reqType: 'NFR' })}
                    onEdit={onEdit}
                    onLink={onLink}
                    onDelete={onDelete}
                    onDescExpand={setDescReq}
                    onAddDesc={onAddDesc}
                    onExpandNode={toggleNode}
                    onToggleNode={toggleNode}
                    structureMode={structure.active}
                    selectedSlug={structure.selectedSlug}
                    onSelectRow={structure.select}
                    moveOptions={structure.options}
                    onMoveOp={structure.applyOp}
                    draggingSlug={structure.draggingSlug}
                    onDragStartRow={structure.startDrag}
                    onDragEndRow={structure.endDrag}
                    dropReasonFor={structure.dropReasonFor}
                    onDropOnRow={structure.dropOn}
                    failedSlug={structure.failedSlug}
                  />
                </>
              )}
            </>
          )}
        </main>

        {/* В режиме структуры нижняя панель отдаётся перемещению: пока строку
            двигают, «+ Функция» и AI-подгрузка не нужны (макет П1). */}
        {structure.active ? (
          <StructureBar
            selectedName={structure.selected?.name ?? null}
            currentParentName={structure.currentParentName}
            level={structure.level}
            depth={structure.depth}
            descendants={structure.descendants}
            options={structure.options}
            error={structure.error}
            canUndo={structure.canUndo}
            busy={structure.busy}
            history={structure.history}
            onUndo={structure.undo}
            onRetry={structure.retry}
            onDismissError={structure.dismissError}
            onExit={structure.exit}
          />
        ) : (
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
              <button
                type="button"
                className="btn btn-secondary inline-flex items-center gap-1.5 text-sm"
                style={{ color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}
                data-testid="footer-ai-import"
                onClick={() => setAiImportOpen(true)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2zm7 12l.9 2.6L22.5 18l-2.6.9L19 21.5l-.9-2.6L15.5 18l2.6-.9L19 14z" />
                </svg>
                AI подгрузка из документации
              </button>
              <button
                type="button"
                className="btn btn-secondary inline-flex items-center gap-1.5 text-sm"
                style={{ color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}
                data-testid="footer-ai-backlog-import"
                onClick={() => setAiBacklogOpen(true)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
                AI подгрузка из бэклога
              </button>
            </div>
          </footer>
        )}

        {/* Переезд раздела с потомками — единственное перемещение, которое
            спрашивает подтверждение: масштаб и новая глубина названы заранее
            (макет П5). */}
        {structure.pending ? (
          <ConfirmDialog
            testid="move-subtree-dialog"
            title={`Перенести раздел «${structure.pending.name}» со всем содержимым?`}
            message={
              <span data-testid="move-subtree-message">
                Вместе с ним переедут{' '}
                <strong>{requirementsLabel(structure.pending.descendantNames.length)}</strong>:{' '}
                {structure.pending.descendantNames.map((n) => `«${n}»`).join(', ')}. Новый родитель
                — «{structure.pending.parentName}», строка встанет на уровень{' '}
                {structure.pending.newDepth}. Изменится одна связь; связи потомков между собой,
                RICE, сроки и источники сохранятся.
              </span>
            }
            confirmLabel="Перенести"
            busyLabel="Переносим…"
            busy={structure.busy}
            onCancel={structure.cancelPending}
            onConfirm={structure.confirmPending}
          />
        ) : null}

        {descReq ? (
          <DescPanel
            requirement={descReq}
            path={ancestorNamesOf(descReq, requirements)}
            nameBySlug={nameBySlug}
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
              // UX-2: N = все транзитивные потомки (из дерева). Всего удалится
              // N потомков + сам узел = total. Число фактически удалённых
              // приходит с сервера в ответе как `deleted`.
              const descendants = descendantCountOf(req, requirements);
              const cascade = descendants > 0;
              const total = descendants + 1;
              return (
                <ConfirmDialog
                  testid="delete-dialog"
                  danger
                  icon={
                    cascade ? <TriangleAlert className="icon-sm" aria-hidden="true" /> : undefined
                  }
                  iconTone={cascade ? 'warning' : 'danger'}
                  title={cascade ? 'Удалить требование со вложенными?' : 'Удалить требование?'}
                  message={
                    cascade ? (
                      <span data-testid="delete-dialog-cascade">
                        «{req.name}» содержит {requirementsLabel(descendants)} во вложениях. Будут
                        удалены{' '}
                        <strong>все они и само требование — {requirementsLabel(total)}</strong>, а
                        связи с другими требованиями очищены. Действие необратимо.
                      </span>
                    ) : (
                      `«${req.name}» будет удалено, связи с другими требованиями — очищены. Действие необратимо.`
                    )
                  }
                  note={
                    cascade
                      ? {
                          tone: 'danger',
                          text: 'Каскадное удаление необратимо: восстановить вложенные требования будет нельзя.',
                        }
                      : {
                          tone: 'success',
                          text: 'Вложенных требований нет — удаление безопасно.',
                        }
                  }
                  typeToConfirm={
                    cascade
                      ? {
                          expected: req.name,
                          label: 'Для подтверждения введите имя требования',
                          placeholder: req.name,
                          inputTestid: 'delete-dialog-input',
                          hint: 'Кнопка активна, когда имя введено точно.',
                        }
                      : undefined
                  }
                  error={deleteError}
                  confirmLabel={cascade ? `Удалить ${requirementsLabel(total)}` : 'Удалить'}
                  busyLabel="Удаляем…"
                  busy={deleteMut.isPending}
                  onCancel={closeModal}
                  onConfirm={async () => {
                    setDeleteError(null);
                    try {
                      await deleteMut.mutateAsync({ slug: req.slug, cascade });
                      closeModal();
                    } catch (err) {
                      if (err instanceof ApiError && err.code === 'HAS_CHILDREN') {
                        // Should not happen (we send cascade=true when there are
                        // children), but surface it cleanly if the tree was stale.
                        setDeleteError(
                          'У требования появились вложенные элементы. Обновите страницу и повторите удаление.',
                        );
                      } else {
                        setDeleteError(errorMessage(err));
                      }
                    }
                  }}
                />
              );
            })()
          : null}

        {aiImportOpen ? (
          <AiImportModal projectId={id} onClose={() => setAiImportOpen(false)} />
        ) : null}

        {aiBacklogOpen ? (
          <AiBacklogImportModal projectId={id} onClose={() => setAiBacklogOpen(false)} />
        ) : null}
      </div>
    </>
  );
}
