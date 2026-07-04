import { describe, it, expect } from 'vitest';
import { MarkerType } from '@xyflow/react';
import { getEdgeStyle } from './graphEdgeStyles';

describe('getEdgeStyle', () => {
  it('PARENT_OF — gray solid line with arrowClosed', () => {
    const style = getEdgeStyle('PARENT_OF');
    expect(style.style?.stroke).toBe('#64748b');
    expect(style.style?.strokeWidth).toBe(2);
    expect(style.markerEnd?.type).toBe(MarkerType.ArrowClosed);
    expect(style.style?.strokeDasharray).toBeUndefined();
  });

  it('DEPENDS_ON — blue dashed line with arrowClosed', () => {
    const style = getEdgeStyle('DEPENDS_ON');
    expect(style.style?.stroke).toBe('#3b82f6');
    expect(style.style?.strokeDasharray).toBe('5 5');
    expect(style.markerEnd?.type).toBe(MarkerType.ArrowClosed);
  });

  it('BLOCKED_BY — red dashed line with arrowClosed', () => {
    const style = getEdgeStyle('BLOCKED_BY');
    expect(style.style?.stroke).toBe('#ef4444');
    expect(style.style?.strokeDasharray).toBe('5 5');
    expect(style.markerEnd?.type).toBe(MarkerType.ArrowClosed);
  });

  it('RELATES_TO — green line with arrows on both ends', () => {
    const style = getEdgeStyle('RELATES_TO');
    expect(style.style?.stroke).toBe('#22c55e');
    expect(style.markerEnd?.type).toBe(MarkerType.Arrow);
    expect(style.markerStart?.type).toBe(MarkerType.Arrow);
  });

  // Task 12 · F-2.3: remaining edge-style branches (lines 46–55).
  it('CHILD_OF — styled exactly like PARENT_OF (fallback for non-deduplicated edges)', () => {
    const child = getEdgeStyle('CHILD_OF');
    const parent = getEdgeStyle('PARENT_OF');
    expect(child).toEqual(parent);
  });

  it('unknown link type — neutral gray thin line with a plain arrow', () => {
    const style = getEdgeStyle('SOME_FUTURE_TYPE' as Parameters<typeof getEdgeStyle>[0]);
    expect(style.style?.stroke).toBe('#94a3b8');
    expect(style.style?.strokeWidth).toBe(1);
    expect(style.markerEnd?.type).toBe(MarkerType.Arrow);
    expect(style.markerStart).toBeUndefined();
  });
});
