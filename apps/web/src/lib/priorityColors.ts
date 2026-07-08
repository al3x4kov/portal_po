import { PRIORITY_COLORS, type PriorityColor } from '@po/core';

/**
 * todo_19 (T-210): single source of truth mapping a fixed priority-palette key
 * (`@po/core` `PRIORITY_COLORS`) to project design tokens. The `bg`/`fg` pair is
 * used for the tinted priority badge (name + colour, WCAG AA on both themes);
 * `solid` is the saturated swatch shown in the colour picker. Every value is a
 * CSS custom property declared once in `index.css` (light + dark), so the theme
 * switch is automatic and nothing is hard-coded at the call site (НФТ-5, НФТ-7).
 */
export interface PriorityColorTokens {
  /** Tinted background of the badge. */
  bg: string;
  /** Foreground text/dot colour on the tint (≥ AA). */
  fg: string;
  /** Saturated solid colour for the palette swatch. */
  solid: string;
}

export const PRIORITY_COLOR_VAR: Record<PriorityColor, PriorityColorTokens> = {
  red: { bg: 'var(--prio-red-bg)', fg: 'var(--prio-red-fg)', solid: 'var(--prio-red-solid)' },
  amber: {
    bg: 'var(--prio-amber-bg)',
    fg: 'var(--prio-amber-fg)',
    solid: 'var(--prio-amber-solid)',
  },
  blue: { bg: 'var(--prio-blue-bg)', fg: 'var(--prio-blue-fg)', solid: 'var(--prio-blue-solid)' },
  green: {
    bg: 'var(--prio-green-bg)',
    fg: 'var(--prio-green-fg)',
    solid: 'var(--prio-green-solid)',
  },
  purple: {
    bg: 'var(--prio-purple-bg)',
    fg: 'var(--prio-purple-fg)',
    solid: 'var(--prio-purple-solid)',
  },
  sky: { bg: 'var(--prio-sky-bg)', fg: 'var(--prio-sky-fg)', solid: 'var(--prio-sky-solid)' },
  gray: { bg: 'var(--prio-gray-bg)', fg: 'var(--prio-gray-fg)', solid: 'var(--prio-gray-solid)' },
  pink: { bg: 'var(--prio-pink-bg)', fg: 'var(--prio-pink-fg)', solid: 'var(--prio-pink-solid)' },
};

/** Human-readable colour names (accessible labels for the swatch buttons). */
export const PRIORITY_COLOR_LABEL: Record<PriorityColor, string> = {
  red: 'Красный',
  amber: 'Янтарный',
  blue: 'Синий',
  green: 'Зелёный',
  purple: 'Фиолетовый',
  sky: 'Голубой',
  gray: 'Серый',
  pink: 'Розовый',
};

/** Safe fallback: an unknown/legacy colour string renders as the neutral token. */
export function priorityColorTokens(color: string | undefined): PriorityColorTokens {
  if (color && (PRIORITY_COLORS as readonly string[]).includes(color)) {
    return PRIORITY_COLOR_VAR[color as PriorityColor];
  }
  return PRIORITY_COLOR_VAR.gray;
}
