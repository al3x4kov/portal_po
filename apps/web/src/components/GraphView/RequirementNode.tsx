import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TriangleAlert } from 'lucide-react';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../../lib/criticality';
import type { RequirementNodeData } from './types';

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Custom ReactFlow node for a Requirement (FR-G3).
 * Displays type badge, truncated name, criticality, implemented indicator.
 *
 * Broken files (§2.20.1, graph-view mockup) get a separate visual language:
 * red dashed border, TriangleAlert icon, «Битый файл» label, NO criticality
 * badges, and a hover/focus tooltip with the parse error text.
 */
export const RequirementNode = memo(function RequirementNode({
  data,
}: NodeProps & { data: RequirementNodeData; type: unknown }) {
  const { slug, name, type, criticality, implemented, isBroken, description, onClick } =
    data as RequirementNodeData;

  if (isBroken) {
    return (
      <div
        className="tip-host rounded-lg p-3 shadow-sm"
        style={{
          width: 220,
          background: 'var(--color-danger-bg)',
          border: '1.5px dashed var(--color-danger)',
        }}
        tabIndex={0}
        aria-label={`Битый файл: ${name}. ${description ?? 'Файл не читается.'}`}
        data-testid={`graph-node-${slug}`}
      >
        <Handle type="target" position={Position.Top} style={{ opacity: 0.5 }} />
        <div className="flex items-center gap-2">
          <TriangleAlert
            className="icon"
            style={{ color: 'var(--color-danger-fg)' }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p
              className="font-bold"
              style={{ fontSize: 'var(--text-min)', color: 'var(--color-danger-fg)' }}
            >
              Битый файл
            </p>
            <p
              className="mono truncate text-xs"
              style={{ color: 'var(--color-danger-fg)' }}
              title={name}
            >
              {name}
            </p>
          </div>
        </div>
        {/* Тултип с текстом ошибки (§2.20.1) — виден по hover/focus */}
        <div
          className="tip tip-below"
          style={{ whiteSpace: 'normal', width: 220, fontWeight: 400 }}
          role="tooltip"
          data-testid={`graph-node-${slug}-tip`}
        >
          <span className="block font-semibold">Файл не читается</span>
          {description ?? 'Требование не загружено. Исправьте файл вручную или удалите его.'}
        </div>
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0.5 }} />
      </div>
    );
  }

  const borderColor = CRITICALITY_COLOR_VAR[criticality];
  const bgClass =
    type === 'FUNCTION' ? 'bg-blue-50 dark:bg-blue-950' : 'bg-orange-50 dark:bg-orange-950';

  const displayName = truncate(name, 60);

  return (
    <div
      className={`${bgClass} rounded-lg border-2 p-3 shadow-sm`}
      style={{
        width: 220,
        borderColor,
        cursor: 'pointer',
      }}
      role="button"
      tabIndex={0}
      aria-label={`Требование: ${name}`}
      data-testid={`graph-node-${slug}`}
      onClick={() => onClick(slug)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(slug);
        }
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0.5 }} />

      {/* Header: type badge */}
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 font-bold uppercase tracking-wide"
          style={
            type === 'FUNCTION'
              ? {
                  fontSize: 'var(--text-min)',
                  background: 'rgba(59,130,246,0.15)',
                  color: '#3b82f6',
                }
              : {
                  fontSize: 'var(--text-min)',
                  background: 'rgba(249,115,22,0.15)',
                  color: '#f97316',
                }
          }
        >
          {type === 'FUNCTION' ? 'ФТ' : 'НФТ'}
        </span>
      </div>

      {/* Name (truncated) */}
      <div
        className="mb-2 text-sm font-semibold leading-snug"
        title={name}
        style={{ color: 'var(--color-text, #0f172a)', wordBreak: 'break-word' }}
      >
        {displayName}
      </div>

      {/* Footer: criticality + implemented */}
      <div className="flex items-center justify-between gap-1">
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 font-semibold"
          style={{
            fontSize: 'var(--text-min)',
            color: borderColor,
            background: 'rgba(0,0,0,0.05)',
          }}
        >
          {CRITICALITY_LABEL[criticality]}
        </span>
        <span
          className="text-xs font-semibold"
          title={implemented ? 'Реализовано' : 'Не реализовано'}
          aria-label={implemented ? 'Реализовано' : 'Не реализовано'}
        >
          {implemented ? (
            <span style={{ color: '#22c55e' }}>✓</span>
          ) : (
            <span style={{ color: 'var(--color-warning-fg, #d97706)' }}>⏱</span>
          )}
        </span>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0.5 }} />
    </div>
  );
});
