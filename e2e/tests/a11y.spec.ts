import { expect, test } from '@playwright/test';
import { expectNoSeriousA11y, focusInside } from './helpers/a11y.js';
import { addRequirement, createProject, rowByName, uniqueName } from './helpers/app.js';

/**
 * QA-1 · Accessibility (Q4). Two complementary layers:
 *  (a) axe-core scans of the Start / New / Main screens and the open
 *      RequirementModal / LinkModal — zero serious/critical violations;
 *  (b) keyboard focus management (UX-5, WCAG 2.4.3 / 2.1.2): focus enters the
 *      dialog, Tab is trapped inside, Esc closes and returns focus to the
 *      trigger; the destructive delete dialog defaults focus to the safe button.
 *
 * The axe policy (WCAG 2.1 AA tags, zero serious/critical, empty baseline)
 * lives in helpers/a11y.ts and is shared with a11y-ai.spec.ts (Task 12 Q-1).
 */

test.describe('QA-1 · a11y axe scans (0 serious/critical)', () => {
  test('Start screen has no serious/critical violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();
    await expectNoSeriousA11y(page, 'Start');
  });

  test('New-project screen has no serious/critical violations', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-new').click();
    await expect(page.getByTestId('newproject-page')).toBeVisible();
    await expectNoSeriousA11y(page, 'NewProject');
  });

  test('Main screen + open modals have no serious/critical violations', async ({ page }) => {
    await createProject(page, uniqueName('a11y'));
    const ft = uniqueName('F-a11y');
    const ft2 = uniqueName('F-a11y-2');
    await addRequirement(page, { kind: 'function', name: ft, criticality: 'HIGH' });
    await addRequirement(page, { kind: 'function', name: ft2, criticality: 'MEDIUM' });
    await expectNoSeriousA11y(page, 'Main');

    // Open RequirementModal (edit) and scan.
    await rowByName(page, ft).locator('[data-testid^="req-name-"]').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await expectNoSeriousA11y(page, 'RequirementModal');
    await page.getByTestId('requirement-modal-close').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();

    // Open LinkModal and scan.
    await rowByName(page, ft).locator('[data-testid^="link-btn-"]').click();
    await expect(page.getByTestId('link-modal')).toBeVisible();
    await expectNoSeriousA11y(page, 'LinkModal');
    await page.getByTestId('link-cancel').click();
    await expect(page.getByTestId('link-modal')).toBeHidden();
  });
});

test.describe('QA-1 · focus-trap, Esc and focus return (UX-5)', () => {
  test('RequirementModal autofocuses the name, traps Tab, Esc closes', async ({ page }) => {
    await createProject(page, uniqueName('trap'));

    // The trigger (section "+ Функция") receives focus, then opens the modal.
    const trigger = page.getByTestId('add-function');
    await trigger.focus();
    await trigger.click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();

    // Autofocus lands on the name field, inside the dialog (focus enters).
    await expect(page.getByTestId('req-name')).toBeFocused();

    // Tab many times: focus must never escape the dialog (forward wrap).
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInside(page, 'requirement-modal'), `Tab #${i} escaped the modal`).toBe(
        true,
      );
    }
    // Shift+Tab is also trapped (backward wrap).
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInside(page, 'requirement-modal'), `Shift+Tab #${i} escaped`).toBe(true);
    }

    // Esc closes the dialog and returns focus to the trigger (UX-5). The opener
    // is captured during Modal's first render, before the name field's autoFocus
    // fires, so focus is restored to the trigger rather than lost to <body>.
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('delete dialog defaults focus to the safe Cancel button and traps Tab', async ({ page }) => {
    await createProject(page, uniqueName('trap-del'));
    const name = uniqueName('F-del');
    await addRequirement(page, { kind: 'function', name });

    const delBtn = rowByName(page, name).locator('[data-testid^="delete-btn-"]');
    await delBtn.click();
    const dialog = page.getByTestId('delete-dialog');
    await expect(dialog).toBeVisible();

    // UX-5: destructive dialog opens with focus on the safe (Cancel) action.
    await expect(page.getByTestId('delete-dialog-cancel')).toBeFocused();

    // Tab stays inside the alertdialog.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInside(page, 'delete-dialog'), `Tab #${i} escaped the dialog`).toBe(true);
    }

    // Esc closes and returns focus to the delete trigger.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(delBtn).toBeFocused();
  });
});
