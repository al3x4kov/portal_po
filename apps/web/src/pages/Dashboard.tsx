import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import type { Requirement } from '@po/core';
import { useProject, useRequirements } from '../api/hooks';
import { PathHeader } from '../components/PathHeader';

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
        {/* Y grid lines */}
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
              <text
                x={PAD.left - 4}
                y={y + 4}
                textAnchor="end"
                fontSize={9}
                fill="var(--color-text-3)"
              >
                {Math.round(maxVal * f)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
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
                  fontSize={8}
                  fill="var(--color-text-3)"
                >
                  {day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* X axis */}
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

function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'danger' | 'warning' | 'success';
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
      data-testid="dashboard-stat"
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

  // a) Root functions: no CHILD_OF link (= no parent)
  const rootFunctions = useMemo(
    () => functional.filter((r) => !r.links.some((l) => l.type === 'CHILD_OF')),
    [functional],
  );

  // b) Functions without a linked NFR: no link pointing to an NFR slug
  const nfrSlugs = useMemo(() => new Set(nfr.map((r) => r.slug)), [nfr]);
  const functionsWithoutNfr = useMemo(
    () =>
      functional.filter(
        (r) => !r.links.some((l) => l.type === 'BLOCKED_BY' && nfrSlugs.has(l.targetSlug)),
      ),
    [functional, nfrSlugs],
  );

  // c) Activity by day across all requirements
  const activityByDay = useMemo(() => groupByDay(requirements), [requirements]);

  const isLoading = reqQuery.isLoading || projectQuery.isLoading;

  return (
    <div className="flex min-h-screen flex-col" data-testid="dashboard-page">
      <PathHeader
        name={projectQuery.data?.name ?? id}
        mainPath={projectQuery.data?.mainPath ?? ''}
        projectId={id}
        activePage="dashboard"
      />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
        <h1 className="text-xl font-bold">Дашборд проекта</h1>

        {isLoading ? (
          <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
            Загрузка…
          </p>
        ) : (
          <>
            {/* Stat cards */}
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
                detail="без родительской функции"
                tone={rootFunctions.length === functional.length ? 'warning' : undefined}
              />
              <StatCard
                label="ФТ без НФТ"
                value={functionsWithoutNfr.length}
                detail="нет связанного нефункц. требования"
                tone={functionsWithoutNfr.length > 0 ? 'warning' : 'success'}
              />
            </div>

            {/* Activity chart */}
            <div className="card p-5">
              <h2 className="mb-4 font-semibold">
                Динамика изменений ФТ/НФТ{' '}
                <span className="text-xs font-normal" style={{ color: 'var(--color-text-3)' }}>
                  (по дате последнего обновления, последние 30 дней)
                </span>
              </h2>
              <ActivityChart byDay={activityByDay} />
            </div>

            {/* Functions without NFT list */}
            {functionsWithoutNfr.length > 0 ? (
              <div className="card p-5">
                <h2 className="mb-3 font-semibold">
                  Функции без нефункционального требования ({functionsWithoutNfr.length})
                </h2>
                <ul className="space-y-1.5">
                  {functionsWithoutNfr.map((r) => (
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
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
