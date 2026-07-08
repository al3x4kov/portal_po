import { useMemo } from 'react';
import type { Requirement, SourcePriority, SourceType } from '@po/core';
import { SOURCE_TYPE_ICON, SOURCE_TYPE_LABEL } from '../lib/sourceTypes';
import { PriorityBadge } from './PriorityBadge';

interface SourceSliceProps {
  requirements: Requirement[];
  priorities: readonly SourcePriority[];
  onOpen: (req: Requirement) => void;
}

interface SliceItem {
  req: Requirement;
  priorityId: string;
}

interface SliceGroup {
  name: string;
  type: SourceType;
  items: SliceItem[];
}

/**
 * todo_19 (T-208): «По источникам» slice. Groups requirements by source name;
 * a requirement with N sources appears in N groups, each time with the priority
 * it carries FOR THAT source. Per-group counters roll up the senior priorities
 * — the "у вас уже N фичей с верхним приоритетом" argument for stakeholders.
 */
export function SourceSlice({
  requirements,
  priorities,
  onOpen,
}: SourceSliceProps): React.ReactElement {
  const orderOf = useMemo(() => new Map(priorities.map((p) => [p.id, p.order])), [priorities]);
  const priorityById = useMemo(() => new Map(priorities.map((p) => [p.id, p])), [priorities]);

  const groups = useMemo<SliceGroup[]>(() => {
    const map = new Map<string, SliceGroup>();
    for (const req of requirements) {
      for (const s of req.sources ?? []) {
        const key = s.name;
        let g = map.get(key);
        if (!g) {
          g = { name: s.name, type: s.type, items: [] };
          map.set(key, g);
        }
        g.items.push({ req, priorityId: s.priorityId });
      }
    }
    return [...map.values()].sort(
      (a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name),
    );
  }, [requirements]);

  if (groups.length === 0) {
    return (
      <section
        className="card flex flex-col items-center px-6 py-14 text-center"
        data-testid="source-slice-empty"
      >
        <p className="font-semibold">Пока нет требований с источниками</p>
        <p className="mt-1 max-w-sm text-sm" style={{ color: 'var(--color-text-3)' }}>
          Заполните источники на вкладке «Приоритизация» требования — здесь появится срез по каждому
          источнику с его приоритетами.
        </p>
      </section>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="source-slice">
      {groups.map((g) => {
        // Roll up priority counts (senior first).
        const counts = new Map<string, number>();
        for (const it of g.items) counts.set(it.priorityId, (counts.get(it.priorityId) ?? 0) + 1);
        const countRows = [...counts.entries()]
          .map(([pid, n]) => ({ p: priorityById.get(pid), n }))
          .filter((r): r is { p: SourcePriority; n: number } => r.p !== undefined)
          .sort((a, b) => a.p.order - b.p.order);
        const items = [...g.items].sort(
          (a, b) => (orderOf.get(a.priorityId) ?? 99) - (orderOf.get(b.priorityId) ?? 99),
        );
        const Icon = SOURCE_TYPE_ICON[g.type];
        return (
          <section className="card p-4" key={g.name} data-testid={`slice-group-${g.name}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <strong className="flex items-center gap-2 text-sm">
                <Icon
                  className="icon-sm"
                  aria-hidden="true"
                  style={{ color: 'var(--color-text-3)' }}
                />
                <span title={SOURCE_TYPE_LABEL[g.type]}>{g.name}</span>
              </strong>
              <span className="flex flex-wrap gap-1.5" data-testid={`slice-counts-${g.name}`}>
                {countRows.map(({ p, n }) => (
                  <PriorityBadge
                    key={p.id}
                    name={`${p.name} × ${n}`}
                    color={p.color}
                    size="sm"
                    testid={`slice-count-${g.name}-${p.id}`}
                  />
                ))}
              </span>
            </div>
            <ul>
              {items.map((it) => {
                const p = priorityById.get(it.priorityId);
                return (
                  <li
                    key={`${it.req.slug}`}
                    className="flex items-center justify-between gap-3 border-t py-2 text-sm"
                    style={{ borderColor: 'var(--color-border)' }}
                    data-testid={`slice-item-${g.name}-${it.req.slug}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 truncate text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
                      onClick={() => onOpen(it.req)}
                      title={`Редактировать «${it.req.name}»`}
                    >
                      {it.req.name}
                    </button>
                    {p ? (
                      <PriorityBadge
                        name={p.name}
                        color={p.color}
                        size="sm"
                        testid={`slice-item-prio-${g.name}-${it.req.slug}`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
