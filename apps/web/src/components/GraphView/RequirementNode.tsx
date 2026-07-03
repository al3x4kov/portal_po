import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Criticality } from '@po/core';
import type { RequirementNodeData } from './types';

const CRITICALITY_BORDER: Record<Criticality, string> = {
  LOW: 'var(--color-text-3)',
  MEDIUM: 'var(--color-warning-fg)',
  HIGH: 'var(--color-warning)',
  CRITICAL: 'var(--color-danger)',
  BLOCKER: '#7f1d1d',
};

const CRITICALITY_LABEL: Record<Criticality, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
  BLOCKER: 'Blocker',
};

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Custom ReactFlow node for a Requirement (FR-G3).
 * Displays type badge, truncated name, criticality, implemented indicator.
 */
export const RequirementNode = memo(function RequirementNode({
  data,
}: NodeProps & { data: RequirementNodeData; type: unknown }) {
  const { slug, name, type, criticality, implemented, isBroken, onClick } =
    data as RequirementNodeData;

  const borderColor = isBroken ? 'var(--color-danger)' : CRITICALITY_BORDER[criticality];
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

      {/* Header: type badge + broken indicator */}
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={
            type === 'FUNCTION'
              ? { background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }
              : { background: 'rgba(249,115,22,0.15)', color: '#f97316' }
          }
        >
          {type === 'FUNCTION' ? 'ФТ' : 'НФТ'}
        </span>
        {isBroken ? (
          <span title="Ошибка парсинга" aria-label="Ошибка парсинга">
            ⚠️
          </span>
        ) : null}
      </div>

      {/* Name (truncated) */}
      <div
        className="mb-2 text-sm font-semibold leading-snug"
        title={name}
        style={{ color: 'var(--color-text, #0f172a)', wordBreak: 'break-word' }}
      >
        {displayName}
      </div>

      {/* Broken error text */}
      {isBroken ? (
        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--color-danger, #ef4444)' }}>
          Ошибка парсинга
        </div>
      ) : null}

      {/* Footer: criticality + implemented */}
      <div className="flex items-center justify-between gap-1">
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ color: borderColor, background: 'rgba(0,0,0,0.05)' }}
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
