import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Shared axe-core helper for the a11y suites (a11y.spec.ts, a11y-ai.spec.ts).
 * Policy (QA-1 / NFR-7): zero serious/critical violations on every scanned
 * screen/state; WCAG 2.1 AA tag set.
 */

const IMPACTS = ['serious', 'critical'] as const;

/**
 * No baselined a11y defects: UX-9 fixed the amber "warning" badge contrast by
 * introducing a dedicated `--color-warning-fg` token, so `color-contrast` is
 * no longer excluded. Any serious/critical rule — contrast included — now fails
 * the suite. Keep this set empty; add a rule only with a tracked defect ticket.
 */
export const KNOWN_DEFECT_RULES = new Set<string>();

export interface A11yScanOptions {
  /**
   * CSS selectors excluded from the scan. Use ONLY to baseline a KNOWN,
   * recorded product defect (with a comment naming it at the call site) —
   * never to silence an unexplored violation.
   */
  exclude?: string[];
}

/** Run axe on the current page and fail on any (non-baselined) serious/critical violation. */
export async function expectNoSeriousA11y(
  page: Page,
  context: string,
  opts: A11yScanOptions = {},
): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const sel of opts.exclude ?? []) builder.exclude(sel);
  const results = await builder.analyze();
  const blocking = results.violations.filter(
    (v) =>
      v.impact != null &&
      (IMPACTS as readonly string[]).includes(v.impact) &&
      !KNOWN_DEFECT_RULES.has(v.id),
  );
  const summary = blocking
    .map((v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.help}`)
    .join('\n');
  expect(blocking, `serious/critical a11y violations on ${context}:\n${summary}`).toEqual([]);
}

/** Whether the currently-focused element lives inside the given container. */
export async function focusInside(page: Page, testid: string): Promise<boolean> {
  return page.evaluate((id) => {
    const modal = document.querySelector(`[data-testid="${id}"]`);
    return (
      modal != null && document.activeElement != null && modal.contains(document.activeElement)
    );
  }, testid);
}
