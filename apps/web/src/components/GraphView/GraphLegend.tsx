import { useState } from 'react';
import { Panel } from '@xyflow/react';

interface LegendEntry {
  label: string;
  color: string;
  dashed: boolean;
  bidirectional: boolean;
}

const ENTRIES: LegendEntry[] = [
  { label: 'PARENT_OF', color: '#64748b', dashed: false, bidirectional: false },
  { label: 'DEPENDS_ON', color: '#3b82f6', dashed: true, bidirectional: false },
  { label: 'BLOCKED_BY', color: '#ef4444', dashed: true, bidirectional: false },
  { label: 'RELATES_TO', color: '#22c55e', dashed: false, bidirectional: true },
];

const LABELS: Record<string, string> = {
  PARENT_OF: 'Родитель',
  DEPENDS_ON: 'Зависит от',
  BLOCKED_BY: 'Блокировано',
  RELATES_TO: 'Связано',
};

/**
 * Collapsible legend overlay in the bottom-left corner of the ReactFlow canvas.
 * FR-G7.3.
 */
export function GraphLegend(): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Panel position="bottom-left" data-testid="graph-legend">
      <div
        className="rounded-lg border shadow-sm overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          minWidth: 170,
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
          <div className="px-3 pb-3 space-y-2">
            {ENTRIES.map((entry) => (
              <div key={entry.label} className="flex items-center gap-2">
                {/* Line swatch */}
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
                      {/* Arrowhead left */}
                      <polygon
                        points="4,3 4,9 0,6"
                        fill={entry.color}
                      />
                      {/* Arrowhead right */}
                      <polygon
                        points="28,3 28,9 32,6"
                        fill={entry.color}
                      />
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
                      {/* Arrowhead right */}
                      <polygon
                        points="26,3 26,9 30,6"
                        fill={entry.color}
                      />
                    </>
                  )}
                </svg>
                <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  {LABELS[entry.label]}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
