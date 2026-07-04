import type { AiImportLogEntry } from '@po/core';

/**
 * Palette of the AI-import automation log (Task 11, `data-testid="ai-import-log"`).
 *
 * The log surface is intentionally a fixed dark "terminal" (`#0f172a`) in BOTH
 * light and dark themes, so every colour below must clear WCAG AA 4.5:1 against
 * that exact background — guarded by `contrast.test.ts` (Q-track a11y fix:
 * axe flagged the old slate-500 timestamps at ≈3.8:1).
 */

/** Log background (slate-900), identical in both themes. */
export const AI_IMPORT_LOG_BG = '#0f172a';

/** Regular log message text (slate-300, ≈12:1 on the log background). */
export const AI_IMPORT_LOG_TEXT = '#cbd5e1';

/**
 * Timestamp / level gutter colours on {@link AI_IMPORT_LOG_BG}:
 * info slate-400 ≈7.0:1 (was slate-500 ≈3.8:1 — axe serious), warn amber-400
 * ≈10.7:1, error red-400 ≈6.5:1.
 */
export const AI_IMPORT_LOG_LEVEL_COLOR: Record<AiImportLogEntry['level'], string> = {
  info: '#94a3b8',
  warn: '#fbbf24',
  error: '#f87171',
};
