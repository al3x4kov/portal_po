import { Check } from 'lucide-react';
import { PRIORITY_COLORS, type PriorityColor } from '@po/core';
import { PRIORITY_COLOR_LABEL, PRIORITY_COLOR_VAR } from '../lib/priorityColors';

export interface ColorPalettePickerProps {
  value: PriorityColor;
  onChange: (color: PriorityColor) => void;
  /** Prefix for the swatch test ids (defaults to `color-swatch`). */
  testidPrefix?: string;
}

/**
 * todo_19 (T-210): fixed-palette colour picker for priorities. Renders exactly
 * the `@po/core` `PRIORITY_COLORS` set (no free HEX — Gate-2 decision №1). Each
 * swatch is a labelled radio-like button; the selected one shows a check and an
 * `aria-pressed` state so it is not conveyed by colour alone (НФТ-5).
 */
export function ColorPalettePicker({
  value,
  onChange,
  testidPrefix = 'color-swatch',
}: ColorPalettePickerProps): React.ReactElement {
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="radiogroup"
      aria-label="Цвет приоритета"
      data-testid="color-palette-picker"
    >
      {PRIORITY_COLORS.map((color: PriorityColor) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={PRIORITY_COLOR_LABEL[color]}
            title={PRIORITY_COLOR_LABEL[color]}
            data-testid={`${testidPrefix}-${color}`}
            data-selected={selected}
            className="grid place-items-center rounded-md"
            style={{
              width: 26,
              height: 26,
              background: PRIORITY_COLOR_VAR[color].solid,
              border: selected ? '2px solid var(--color-text)' : '2px solid transparent',
              boxShadow: selected ? '0 0 0 2px var(--color-surface) inset' : undefined,
            }}
            onClick={() => onChange(color)}
          >
            {selected ? <Check size={14} strokeWidth={3} color="#fff" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
