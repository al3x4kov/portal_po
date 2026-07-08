import type { PriorityColor } from '@po/core';
import { priorityColorTokens } from '../lib/priorityColors';

export interface PriorityBadgeProps {
  /** Human-readable priority name from the project dictionary. */
  name: string;
  /** Palette key; unknown/legacy values fall back to the neutral token. */
  color?: PriorityColor | string;
  /** Optional smaller variant used in dense table cells. */
  size?: 'sm' | 'md';
  testid?: string;
  title?: string;
}

/**
 * todo_19 (T-210, ФТ-C1.3 / НФТ-5): renders a source priority as a coloured
 * badge carrying its NAME (never a code like "S0"). Colour is a redundant cue —
 * the text name is always present — and both tint/fg come from the AA-checked
 * palette tokens, so it stays legible in light and dark themes.
 */
export function PriorityBadge({
  name,
  color,
  size = 'md',
  testid = 'priority-badge',
  title,
}: PriorityBadgeProps): React.ReactElement {
  const tokens = priorityColorTokens(color);
  const pad = size === 'sm' ? '2px 8px' : '2px 10px';
  const fontSize = size === 'sm' ? '11px' : '11.5px';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md font-bold"
      style={{ background: tokens.bg, color: tokens.fg, padding: pad, fontSize }}
      data-testid={testid}
      data-color={color ?? 'gray'}
      title={title ?? name}
    >
      <span
        className="inline-block rounded-full"
        style={{ width: 7, height: 7, background: 'currentColor', opacity: 0.9 }}
        aria-hidden="true"
      />
      {name}
    </span>
  );
}
