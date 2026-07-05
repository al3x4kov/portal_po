import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { Requirement } from '@po/core';
import { useProject, useRequirements } from '../api/hooks';
import { Sidebar } from '../components/Sidebar';
import { PathHeader } from '../components/PathHeader';
import { CriticalityBadge } from '../components/badges';
import { useUiStore } from '../store/ui';
import { RequirementModal } from '../components/RequirementModal';
import { ExportModal } from '../components/ExportModal';
import { ExportTasksModal } from '../components/ExportTasksModal';

// T-514: criticality sort order
const CRIT_ORDER: Record<string, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

/** Group requirements by date string (YYYY-MM-DD) using the updatedAt field. */
function groupByDay(reqs: Requirement[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of reqs) {
    const day = r.updatedAt.slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return map;
}

/** Simple inline SVG bar chart for the activity timeline. */
function ActivityChart({ byDay }: { byDay: Map<string, number> }): React.ReactElement {
  const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  if (entries.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
        Нет данных об изменениях.
      </p>
    );
  }

  const maxVal = Math.max(...entries.map(([, v]) => v));
  const W = 600;
  const H = 120;
  const PAD = { top: 8, right: 8, bottom: 28, left: 28 };
  const barW = Math.floor((W - PAD.left - PAD.right) / entries.length) - 2;
  const chartH = H - PAD.top - PAD.bottom;
  const chartW = W - PAD.left - PAD.right;

  return (
    <div className="overflow-x-auto" style={{ maxWidth: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ minWidth: '320px', maxWidth: `${W}px` }}
        aria-label="График активности изменений требований"
        role="img"
      >
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const y = PAD.top + chartH * (1 - f);
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                x2={PAD.left + chartW}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              {/* §2.19.2: подписи осей ≥10px */}
              <text
                x={PAD.left - 4}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill="var(--color-text-3)"
              >
                {Math.round(maxVal * f)}
              </text>
            </g>
          );
        })}

        {entries.map(([day, count], i) => {
          const barH = maxVal === 0 ? 0 : (count / maxVal) * chartH;
          const x = PAD.left + i * ((chartW + 2) / entries.length);
          const y = PAD.top + chartH - barH;
          const showLabel = entries.length <= 14 || i % Math.ceil(entries.length / 10) === 0;
          return (
            <g key={day}>
              <rect
                x={x}
                y={y}
                width={Math.max(barW, 2)}
                height={barH}
                rx={2}
                fill="var(--color-primary)"
                opacity={0.8}
              >
                <title>
                  {day}: {count} изменений
                </title>
              </rect>
              {showLabel ? (
                <text
                  x={x + barW / 2}
                  y={H - PAD.bottom + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--color-text-3)"
                >
                  {day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}

        <line
          x1={PAD.left}
          x2={PAD.left + chartW}
          y1={PAD.top + chartH}
          y2={PAD.top + chartH}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}

/** §2.19.3: списки проблем ограничены 7 позициями + «Показать все (N)». */
const PROBLEM_LIST_LIMIT = 7;

/** One «без описания» list inside the always-visible quality card (§2.19.1). */
function NoDescList({
  title,
  items,
  testid,
  onOpen,
}: {
  title: string;
  items: Requirement[];
  testid: string;
  onOpen: (req: Requirement) => void;
}): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, PROBLEM_LIST_LIMIT);
  return (
    <div data-testid={testid}>
      <h3 className="mb-3 text-sm font-semibold">
        {title}
        <span
          className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold"
          style={{
            background: 'var(--color-warning-bg)',
            color: 'var(--color-warning-fg)',
          }}
        >
          {items.length}
        </span>
      </h3>
      <ul className="space-y-2">
        {visible.map((r) => (
          <li key={r.slug} className="flex items-center gap-2">
            <CriticalityBadge criticality={r.criticality} />
            <span className="min-w-0 flex-1 truncate text-sm" title={r.name}>
              {r.name}
            </span>
            <button
              type="button"
              className="chip flex-none"
              style={{ color: 'var(--color-primary)' }}
              data-testid={`dash-no-desc-open-${r.slug}`}
              onClick={() => onOpen(r)}
            >
              + Описание
            </button>
          </li>
        ))}
      </ul>
      {items.length > PROBLEM_LIST_LIMIT ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-3"
          style={{ color: 'var(--color-primary)' }}
          data-testid={`${testid}-show-all`}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Свернуть' : `Показать все (${items.length})`}
        </button>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  tone,
  testid,
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'danger' | 'warning' | 'success';
  testid?: string;
}): React.ReactElement {
  const colorMap = {
    danger: { bg: 'var(--color-danger-bg)', fg: 'var(--color-danger-fg)' },
    warning: { bg: 'var(--color-warning-bg)', fg: 'var(--color-warning-fg)' },
    success: { bg: 'var(--color-success-bg)', fg: 'var(--color-success-fg)' },
  };
  const colors = tone ? colorMap[tone] : null;
  return (
    <div
      className="card p-5"
      style={colors ? { background: colors.bg } : undefined}
      data-testid={testid ?? 'dashboard-stat'}
    >
      <p
        className="text-3xl font-bold"
        style={{ color: colors ? colors.fg : 'var(--color-primary)' }}
      >
        {value}
      </p>
      <p className="mt-1 text-sm font-medium" style={{ color: colors ? colors.fg : undefined }}>
        {label}
      </p>
      {detail ? (
        <p className="mt-0.5 text-xs" style={{ color: colors ? colors.fg : 'var(--color-text-3)' }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function Dashboard(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);

  const requirements = reqQuery.data?.requirements ?? [];
  const functional = requirements.filter((r) => r.type === 'FUNCTION');
  const nfr = requirements.filter((r) => r.type === 'NFR');

  const rootFunctions = useMemo(
    () => functional.filter((r) => !r.links.some((l) => l.type === 'CHILD_OF')),
    [functional],
  );

  const nfrSlugs = useMemo(() => new Set(nfr.map((r) => r.slug)), [nfr]);
  const functionsWithoutNfr = useMemo(
    () =>
      functional.filter(
        (r) => !r.links.some((l) => l.type === 'BLOCKED_BY' && nfrSlugs.has(l.targetSlug)),
      ),
    [functional, nfrSlugs],
  );

  const activityByDay = useMemo(() => groupByDay(requirements), [requirements]);

  // §2.19.3: список «Функции без НФТ» тоже ограничен 7 позициями.
  const [showAllFnWithoutNfr, setShowAllFnWithoutNfr] = useState(false);

  // T-514: requirements without description, sorted by criticality
  const fnNoDesc = useMemo(
    () =>
      functional
        .filter((r) => !r.description?.trim())
        .sort((a, b) => (CRIT_ORDER[a.criticality] ?? 9) - (CRIT_ORDER[b.criticality] ?? 9)),
    [functional],
  );
  const nfrNoDesc = useMemo(
    () =>
      nfr
        .filter((r) => !r.description?.trim())
        .sort((a, b) => (CRIT_ORDER[a.criticality] ?? 9) - (CRIT_ORDER[b.criticality] ?? 9)),
    [nfr],
  );

  const noDescTotal = fnNoDesc.length + nfrNoDesc.length;

  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const nameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of requirements) m.set(r.slug, r.name);
    return m;
  }, [requirements]);

  const isLoading = reqQuery.isLoading || projectQuery.isLoading;

  return (
    <>
      <Sidebar
        projectId={id}
        activePage="dashboard"
        onOpenExport={() => openModal({ kind: 'export' })}
        onOpenTasks={() => openModal({ kind: 'export-tasks' })}
      />
      <div
        className="flex min-h-screen flex-col"
        style={{ marginLeft: 'var(--sidebar-width)' }}
        data-testid="dashboard-page"
      >
        <PathHeader
          name={projectQuery.data?.name ?? id}
          mainPath={projectQuery.data?.mainPath ?? ''}
        />

        <main className="w-full flex-1 space-y-6 p-6">
          <h1 className="text-xl font-bold">Дашборд проекта</h1>

          {isLoading ? (
            <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
              Загрузка…
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatCard
                  label="Функций (ФТ)"
                  value={functional.length}
                  detail={`из ${requirements.length} требований`}
                />
                <StatCard label="НФТ" value={nfr.length} />
                <StatCard
                  label="Корневых функций"
                  value={rootFunctions.length}
                  detail={rootFunctions.length > 0 ? '⚠ Есть ФТ без родителя' : undefined}
                  tone={rootFunctions.length > 0 ? 'danger' : 'success'}
                  testid="stat-root-functions"
                />
                <StatCard
                  label="ФТ без НФТ"
                  value={functionsWithoutNfr.length}
                  detail="нет связанного нефункц. требования"
                  tone={functionsWithoutNfr.length > 0 ? 'warning' : 'success'}
                />
              </div>

              {/* §2.19.1: карточка «Качество описаний» видна всегда — при нуле
                  пробелов показываем позитивное подтверждение. */}
              <div className="card" data-testid="dash-quality">
                <div
                  className="flex flex-wrap items-center gap-2 border-b px-5 py-3.5"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <h2 className="text-sm font-semibold">Качество описаний</h2>
                  {noDescTotal > 0 ? (
                    <span
                      className="badge"
                      style={{
                        background: 'var(--color-warning-bg)',
                        color: 'var(--color-warning-fg)',
                      }}
                      data-testid="dash-quality-count"
                    >
                      Без описания: {noDescTotal}
                    </span>
                  ) : null}
                </div>
                {noDescTotal === 0 ? (
                  <div className="p-8 text-center" data-testid="dash-quality-ok">
                    <span
                      className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full"
                      style={{
                        background: 'var(--color-success-bg)',
                        color: 'var(--color-success-fg)',
                      }}
                      aria-hidden="true"
                    >
                      <Check className="icon" aria-hidden="true" />
                    </span>
                    <h3 className="mb-1 font-semibold" style={{ color: 'var(--color-success-fg)' }}>
                      Все требования описаны
                    </h3>
                    <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
                      {requirements.length > 0
                        ? `У всех ${requirements.length} требований заполнено описание. Новые пробелы появятся здесь.`
                        : 'Требований пока нет. Пробелы описаний появятся здесь.'}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-2">
                    {fnNoDesc.length > 0 ? (
                      <NoDescList
                        title="ФТ без описания"
                        items={fnNoDesc}
                        testid="dash-no-desc-ft"
                        onOpen={(r) =>
                          openModal({
                            kind: 'requirement',
                            reqType: r.type,
                            requirement: r,
                            focusField: 'description',
                          })
                        }
                      />
                    ) : null}
                    {nfrNoDesc.length > 0 ? (
                      <NoDescList
                        title="НФТ без описания"
                        items={nfrNoDesc}
                        testid="dash-no-desc-nfr"
                        onOpen={(r) =>
                          openModal({
                            kind: 'requirement',
                            reqType: r.type,
                            requirement: r,
                            focusField: 'description',
                          })
                        }
                      />
                    ) : null}
                  </div>
                )}
              </div>

              <div className="card p-5">
                <h2 className="mb-4 font-semibold">
                  Динамика изменений ФТ/НФТ{' '}
                  <span className="text-xs font-normal" style={{ color: 'var(--color-text-3)' }}>
                    (по дате последнего обновления, последние 30 дней)
                  </span>
                </h2>
                <ActivityChart byDay={activityByDay} />
              </div>

              {functionsWithoutNfr.length > 0 ? (
                <div className="card p-5">
                  <h2 className="mb-3 font-semibold">
                    Функции без нефункционального требования ({functionsWithoutNfr.length})
                  </h2>
                  <ul className="space-y-1.5">
                    {(showAllFnWithoutNfr
                      ? functionsWithoutNfr
                      : functionsWithoutNfr.slice(0, PROBLEM_LIST_LIMIT)
                    ).map((r) => (
                      <li
                        key={r.slug}
                        className="flex items-center gap-2 text-sm"
                        data-testid={`dashboard-nfr-missing-${r.slug}`}
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ background: 'var(--color-warning)' }}
                          aria-hidden="true"
                        />
                        {r.name}
                      </li>
                    ))}
                  </ul>
                  {functionsWithoutNfr.length > PROBLEM_LIST_LIMIT ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm mt-3"
                      style={{ color: 'var(--color-primary)' }}
                      data-testid="dashboard-nfr-missing-show-all"
                      onClick={() => setShowAllFnWithoutNfr((v) => !v)}
                    >
                      {showAllFnWithoutNfr
                        ? 'Свернуть'
                        : `Показать все (${functionsWithoutNfr.length})`}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </main>

        {modal?.kind === 'requirement' ? (
          <RequirementModal
            projectId={id}
            reqType={modal.reqType}
            requirement={modal.requirement}
            nameBySlug={nameBySlug}
            linkFrom={modal.linkFrom}
            linkType={modal.linkType}
            focusField={modal.focusField}
            onClose={closeModal}
          />
        ) : null}

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
