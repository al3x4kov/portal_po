import { useState } from 'react';
import { Panel } from '@xyflow/react';

interface EdgeEntry {
  label: string;
  color: string;
  dashed: boolean;
  bidirectional: boolean;
}

/** Edge swatches mirror the actual styles from graphEdgeStyles.ts. */
const EDGE_ENTRIES: EdgeEntry[] = [
  { label: 'Иерархия (входит в)', color: '#64748b', dashed: false, bidirectional: false },
  { label: 'Зависит от', color: '#3b82f6', dashed: true, bidirectional: false },
  { label: 'Блокируется', color: '#ef4444', dashed: true, bidirectional: false },
  { label: 'Смысловая связь', color: '#22c55e', dashed: false, bidirectional: true },
];

/**
 * Collapsible legend overlay in the top-left corner of the ReactFlow canvas
 * (FR-G7.3). Per the graph-view mockup (§2.20.1) it lists node types (ФТ/НФТ),
 * edge types and the «Битый файл» state so a broken file is never mistaken
 * for a requirement. Kept out of the bottom corners so it never overlaps the
 * zoom Controls (bottom-left) or the MiniMap (bottom-right).
 */
export function GraphLegend(): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Panel position="top-left" data-testid="graph-legend">
      <div
        className="overflow-hidden rounded-lg border shadow-sm"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          minWidth: 190,
        }}
      >
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold"
          style={{ color: 'var(--color-text)' }}
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          data-testid="graph-legend-toggle"
        >
          <span>Легенда</span>
          <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        </button>

        {!collapsed ? (
          <div className="space-y-2 px-3 pb-3">
            {/* Типы узлов */}
            <div className="flex items-center gap-2">
              <span
                className="h-3.5 w-3.5 flex-none rounded border bg-blue-50 dark:bg-blue-950"
                style={{ borderColor: 'var(--color-border)' }}
                aria-hidden="true"
              />
              <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                ФТ — функциональное
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="h-3.5 w-3.5 flex-none rounded border bg-orange-50 dark:bg-orange-950"
                style={{ borderColor: 'var(--color-border)' }}
                aria-hidden="true"
              />
              <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                НФТ — нефункциональное
              </span>
            </div>

            {/* Типы рёбер */}
            {EDGE_ENTRIES.map((entry) => (
              <div key={entry.label} className="flex items-center gap-2">
                <svg width="32" height="12" aria-hidden="true" className="shrink-0">
                  {entry.bidirectional ? (
                    <>
                      <line
                        x1="4"
                        y1="6"
                        x2="28"
                        y2="6"
                        stroke={entry.color}
                        strokeWidth="1.5"
                        strokeDasharray={entry.dashed ? '4 3' : undefined}
                      />
                      <polygon points="4,3 4,9 0,6" fill={entry.color} />
                      <polygon points="28,3 28,9 32,6" fill={entry.color} />
                    </>
                  ) : (
                    <>
                      <line
                        x1="2"
                        y1="6"
                        x2="26"
                        y2="6"
                        stroke={entry.color}
                        strokeWidth="1.5"
                        strokeDasharray={entry.dashed ? '4 3' : undefined}
                      />
                      <polygon points="26,3 26,9 30,6" fill={entry.color} />
                    </>
                  )}
                </svg>
                <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  {entry.label}
                </span>
              </div>
            ))}

            {/* Состояние «Битый файл» (§2.20.1) */}
            <div className="flex items-center gap-2">
              <span
                className="h-3.5 w-3.5 flex-none rounded border-2 border-dashed"
                style={{ borderColor: 'var(--color-danger)' }}
                aria-hidden="true"
              />
              <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                Битый файл
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
