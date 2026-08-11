import { expect, test } from '@playwright/test';
import {
  addRequirement,
  apiCreateRequirement,
  createProject,
  linkRequirements,
  openEdit,
  projectIdFromUrl,
  rowByName,
  uniqueName,
} from './helpers/app.js';
import { addSourceCard, openPriorityTab, saveRequirementModal } from './helpers/todo19.js';

/**
 * T4 (todo_17) · Редизайн модалок по new_design/screens/*:
 *   RequirementModal — постоянная зона «Основное» + табы, сохранение без confirm;
 *   LinkModal — радио-карточки типов, chip цели, «первые 25 из N»;
 *   RequirementPicker — «Выбрать все»/«Снять выделение», счётчик;
 *   GeneratePage — «Генерация артефактов», шаги 1→2→3, «Назад» на предыдущий шаг;
 *   ConfirmDialog — уровни трения (0 — toast, 1 — confirm), тексты среднего рода.
 *
 * Изоляция — как в остальном сьюте: свежий проект + уникальные имена на тест.
 */

test.describe('T4 · RequirementModal (requirement-modal.html)', () => {
  test('сохранение редактирования: без confirm, сразу PUT + toast «Сохранено»', async ({
    page,
  }) => {
    await createProject(page, uniqueName('save-no-confirm-proj'));
    const name = uniqueName('F-save');
    const renamed = uniqueName('F-saved');
    await addRequirement(page, { kind: 'function', name });

    // Критичность в дереве — русской меткой (todo_17 §4), не enum-кодом.
    const critCell = rowByName(page, name).getByTestId('req-criticality-cell');
    await expect(critCell).toContainText('Средняя');
    await expect(critCell).not.toContainText('MEDIUM');

    const modal = await openEdit(page, name);
    // Заголовок режима редактирования: «Редактирование: «имя»».
    await expect(modal.locator('h2')).toContainText(`Редактирование: «${name}»`);

    await page.getByTestId('req-name').fill(renamed);
    await page.getByTestId('req-submit').click();

    // Уровень трения 0: модалка закрывается сразу, диалога подтверждения нет.
    await expect(modal).toBeHidden();
    await expect(page.getByTestId('req-save-confirm')).toHaveCount(0);
    // Успех подтверждает toast «Сохранено».
    await expect(page.getByTestId('toast').filter({ hasText: 'Сохранено' })).toBeVisible();
    await expect(rowByName(page, renamed)).toBeVisible();
    await expect(rowByName(page, name)).toBeHidden();
  });

  test('отмена с dirty-формой спрашивает подтверждение (req-cancel-confirm); изменения не сохраняются', async ({
    page,
  }) => {
    await createProject(page, uniqueName('cancel-dirty-proj'));
    const name = uniqueName('F-dirty');
    await addRequirement(page, { kind: 'function', name, description: 'исходное описание' });

    const modal = await openEdit(page, name);
    // ФТ-E3 (todo_19): модалка вкладочная, дефолт — «Основное»; описание за вкладкой.
    await page.getByTestId('req-tab-desc').click();
    await page.getByTestId('req-description').fill('несохранённое изменение');
    await page.getByTestId('req-cancel').click();

    // Подтверждение отмены (единственный confirm, оставшийся в потоке сохранения).
    const confirm = page.getByTestId('req-cancel-confirm');
    await expect(confirm).toBeVisible();

    // «Продолжить редактирование»: диалог закрывается, модалка остаётся.
    await page.getByTestId('req-cancel-confirm-cancel').click();
    await expect(confirm).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('req-description')).toHaveValue('несохранённое изменение');

    // Подтверждаем отмену — модалка закрывается, изменения потеряны.
    await page.getByTestId('req-cancel').click();
    await expect(confirm).toBeVisible();
    await page.getByTestId('req-cancel-confirm-confirm').click();
    await expect(modal).toBeHidden();

    await openEdit(page, name);
    await expect(page.getByTestId('req-description')).toHaveValue('исходное описание');
  });

  test('табы: «Основное» по умолчанию; «Описание»/«Связи»/«Справочно» — за табами (edit); в create-режиме таба «Связи» нет', async ({
    page,
  }) => {
    await createProject(page, uniqueName('tabs-proj'));
    const a = uniqueName('F-tab-a');
    const b = uniqueName('F-tab-b');
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });
    await linkRequirements(page, a, 'RELATES_TO', b);

    // Create-режим: заголовок «Новое требование», таба «Связи» нет, «Справочно» есть.
    await page.getByTestId('add-function').click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h2')).toContainText('Новое требование');
    await expect(page.getByTestId('req-tab-desc')).toBeVisible();
    await expect(page.getByTestId('req-tab-links')).toHaveCount(0);
    await expect(page.getByTestId('req-tab-info')).toBeVisible();
    // Критичность — segmented control из 5 сегментов, включая «Блокер».
    for (const c of ['low', 'medium', 'high', 'critical', 'blocker']) {
      await expect(page.getByTestId(`req-criticality-${c}`)).toBeVisible();
    }
    await page.getByTestId('req-cancel').click(); // create-режим: без confirm
    await expect(modal).toBeHidden();

    // Edit-режим (todo_19): по умолчанию активна вкладка «Основное»; описание и
    // связи скрыты за своими табами.
    await openEdit(page, a);
    await expect(page.getByTestId('req-name')).toBeVisible();
    await expect(page.getByTestId('req-description')).toBeHidden();
    await expect(page.getByTestId('req-links-ft')).toBeHidden();

    // Таб «Описание»: описание видно.
    await page.getByTestId('req-tab-desc').click();
    await expect(page.getByTestId('req-description')).toBeVisible();
    await expect(page.getByTestId('req-links-ft')).toBeHidden();

    // Таб «Связи»: секции ФТ/НФТ видимы, описание скрыто.
    await page.getByTestId('req-tab-links').click();
    await expect(page.getByTestId('req-links-ft')).toBeVisible();
    await expect(page.getByTestId('req-links-nfr')).toBeVisible();
    await expect(page.getByTestId('req-description')).toBeHidden();

    // Таб «Справочно»: кнопка добавления пары «ключ-значение».
    await page.getByTestId('req-tab-info').click();
    await expect(page.getByTestId('info-add-btn')).toBeVisible();
    await expect(page.getByTestId('req-links-ft')).toBeHidden();

    // Возврат на «Описание».
    await page.getByTestId('req-tab-desc').click();
    await expect(page.getByTestId('req-description')).toBeVisible();
  });

  test('источник: карточка на «Приоритизации» сидирует sources[], виден в дереве и round-trip’ится', async ({
    page,
  }) => {
    // todo_18: легаси-поле «Источник» (быстрый select + «Другой…») удалено с вкладки
    // «Основное». Источники задаются ТОЛЬКО карточками на вкладке «Приоритизация»
    // (src-add). Значение после сохранения видно в колонке дерева «Источник» (sources[])
    // и round-trip’ится карточкой src-name-0-input при переоткрытии.
    await createProject(page, uniqueName('source-proj'));
    const first = uniqueName('F-src-first');
    const second = uniqueName('F-src-second');

    // На вкладке «Основное» легаси-поля «Источник»/«Другой…» больше нет.
    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await expect(page.getByTestId('req-source')).toHaveCount(0);
    await expect(page.getByTestId('req-source-custom')).toHaveCount(0);
    await page.getByTestId('req-cancel').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();

    // Источник задаётся карточкой на вкладке «Приоритизация».
    await addRequirement(page, { kind: 'function', name: first });
    await addRequirement(page, { kind: 'function', name: second });

    await openPriorityTab(page, first);
    await addSourceCard(page, 0, { name: 'АС21' });
    await saveRequirementModal(page);

    await openPriorityTab(page, second);
    await addSourceCard(page, 0, { name: 'Регламент 42' });
    await saveRequirementModal(page);

    // Оба видны в колонке дерева «Источник» (sources[]).
    await expect(rowByName(page, first).getByTestId('req-sources-cell')).toContainText('АС21');
    await expect(rowByName(page, second).getByTestId('req-sources-cell')).toContainText(
      'Регламент 42',
    );

    // Источник round-trip’ится карточкой на вкладке «Приоритизация».
    await openPriorityTab(page, first);
    await expect(page.getByTestId('src-name-0-input')).toHaveValue('АС21');
    await page.getByTestId('requirement-modal-close').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();

    await openPriorityTab(page, second);
    await expect(page.getByTestId('src-name-0-input')).toHaveValue('Регламент 42');
    await page.getByTestId('requirement-modal-close').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();
  });
});

test.describe('T4 · LinkModal (link-modal.html)', () => {
  test('тип связи — радио-карточки: дефолт RELATES_TO, порядок как в макете, смена типа кликом', async ({
    page,
  }) => {
    await createProject(page, uniqueName('link-radio-proj'));
    const a = uniqueName('F-radio-a');
    const b = uniqueName('F-radio-b');
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });

    await rowByName(page, a).locator('[data-testid^="link-btn-"]').click();
    const modal = page.getByTestId('link-modal');
    await expect(modal).toBeVisible();

    // Дефолтный тип — двусторонняя связь (RELATES_TO), не CHILD_OF.
    await expect(page.getByTestId('link-type-RELATES_TO')).toBeChecked();

    // Порядок радио-карточек в DOM — как в макете.
    const radios = page.getByTestId('link-type').locator('input[name="link-type"]');
    await expect(radios).toHaveCount(5);
    await expect(radios.nth(0)).toHaveValue('RELATES_TO');
    await expect(radios.nth(1)).toHaveValue('CHILD_OF');
    await expect(radios.nth(2)).toHaveValue('PARENT_OF');
    await expect(radios.nth(3)).toHaveValue('DEPENDS_ON');
    await expect(radios.nth(4)).toHaveValue('BLOCKED_BY');

    // Смена типа радио-карточкой.
    await page.getByTestId('link-type-DEPENDS_ON').check();
    await expect(page.getByTestId('link-type-DEPENDS_ON')).toBeChecked();
    await expect(page.getByTestId('link-type-RELATES_TO')).not.toBeChecked();

    // Выбор цели и создание связи выбранного типа.
    await page.getByTestId('link-search').fill(b);
    await page
      .getByTestId('link-results')
      .locator('[data-testid^="link-result-"]')
      .filter({ hasText: b })
      .first()
      .click();
    await page.getByTestId('link-submit').click();
    await expect(modal).toBeHidden();
  });

  test('выбранная цель — chip под поиском; сброс chip блокирует «Связать»', async ({ page }) => {
    await createProject(page, uniqueName('link-chip-proj'));
    const a = uniqueName('F-chip-a');
    const b = uniqueName('F-chip-b');
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });

    await rowByName(page, a).locator('[data-testid^="link-btn-"]').click();
    await expect(page.getByTestId('link-modal')).toBeVisible();

    // Без цели — submit заблокирован, chip нет.
    await expect(page.getByTestId('link-target-chip')).toHaveCount(0);
    await expect(page.getByTestId('link-submit')).toBeDisabled();

    // Выбор цели → chip с именем, submit активен.
    await page.getByTestId('link-search').fill(b);
    await page
      .getByTestId('link-results')
      .locator('[data-testid^="link-result-"]')
      .filter({ hasText: b })
      .first()
      .click();
    const chip = page.getByTestId('link-target-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(b);
    await expect(page.getByTestId('link-submit')).toBeEnabled();

    // Сброс цели крестиком chip → снова заблокирован.
    await page.getByTestId('link-target-reset').click();
    await expect(page.getByTestId('link-target-chip')).toHaveCount(0);
    await expect(page.getByTestId('link-submit')).toBeDisabled();
    await page.getByTestId('link-cancel').click();
  });

  test('обрезка результатов: «Показаны первые 25 из N — уточните запрос» при 26+ кандидатах', async ({
    page,
  }) => {
    await createProject(page, uniqueName('link-many-proj'));
    const source = uniqueName('F-many-src');
    await addRequirement(page, { kind: 'function', name: source });

    // Быстрый сев 26 кандидатов через REST — итого 26 подходящих целей (> 25).
    const projectId = projectIdFromUrl(page);
    for (let i = 1; i <= 26; i += 1) {
      await apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: uniqueName(`F-many-cand-${i}`),
      });
    }
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await rowByName(page, source).locator('[data-testid^="link-btn-"]').click();
    await expect(page.getByTestId('link-modal')).toBeVisible();

    // Отрисованы ровно 25 кандидатов + видимое сообщение об обрезке.
    const results = page.getByTestId('link-results').locator('button[data-testid^="link-result-"]');
    await expect(results).toHaveCount(25);
    const more = page.getByTestId('link-results-more');
    await expect(more).toBeVisible();
    await expect(more).toContainText('Показаны первые 25 из 26');
    await expect(more).toContainText('уточните запрос');

    // Уточнение запроса убирает сообщение (все совпадения помещаются).
    await page.getByTestId('link-search').fill('F-many-cand-1');
    await expect(page.getByTestId('link-results-more')).toHaveCount(0);
    await page.getByTestId('link-cancel').click();
  });
});

test.describe('T4 · RequirementPicker (picker-modal.html)', () => {
  test('«Снять выделение», «Выбрать все» и счётчик «Выбрано N (из них видно M)» при фильтре', async ({
    page,
  }) => {
    await createProject(page, uniqueName('picker-proj'));
    const fAlpha = uniqueName('F-pick-alpha');
    const fBeta = uniqueName('F-pick-beta');
    const nGamma = uniqueName('N-pick-gamma');
    await addRequirement(page, { kind: 'function', name: fAlpha });
    await addRequirement(page, { kind: 'function', name: fBeta });
    await addRequirement(page, { kind: 'nfr', name: nGamma });

    // Пикер открывается из «Генерации артефактов» → направление tracker.
    await page.getByTestId('sidebar-open-tasks').click();
    await page.getByTestId('export-tasks-dir-tracker').click();
    await page.getByTestId('gen-direction-next').click();
    const picker = page.getByTestId('tracker-select-modal');
    await expect(picker).toBeVisible();

    // По умолчанию выбраны все 3; «видно» не показывается, пока совпадает.
    const counter = page.getByTestId('picker-counter');
    await expect(counter).toContainText('Выбрано 3');
    await expect(counter).not.toContainText('из них видно');
    // Все видимые уже выбраны → «Выбрать все» неактивна, «Снять выделение» активна.
    await expect(page.getByTestId('export-toggle-all')).toBeDisabled();
    await expect(page.getByTestId('export-untoggle-all')).toBeEnabled();

    // Поиск сужает список: выбрано 3, но видно только 1.
    await page.getByTestId('picker-search').fill(fAlpha);
    await expect(counter).toContainText('Выбрано 3');
    await expect(counter).toContainText('(из них видно 1)');

    // «Снять выделение» действует только на видимые: остаются 2 скрытых выбранных.
    await page.getByTestId('export-untoggle-all').click();
    await expect(counter).toContainText('Выбрано 2');
    await expect(page.getByTestId('export-untoggle-all')).toBeDisabled();

    // Сброс фильтров возвращает полный список; «Выбрать все» доступна снова.
    await page.getByTestId('picker-filters-reset').click();
    await expect(page.getByTestId('picker-search')).toHaveValue('');
    await expect(counter).toContainText('Выбрано 2');
    await expect(counter).not.toContainText('из них видно');
    await page.getByTestId('export-toggle-all').click();
    await expect(counter).toContainText('Выбрано 3');
    await expect(page.getByTestId('gen-select-confirm')).toContainText('(3)');
  });
});

test.describe('T4 · GeneratePage «Генерация артефактов» (flow-g*.html)', () => {
  test('шаги 1→2→3, «Назад» из preview на ПРЕДЫДУЩИЙ шаг, имя файла в preview', async ({
    page,
  }) => {
    await createProject(page, uniqueName('gen-steps-proj'));
    // Нереализованное критическое ФТ ⇒ у crit-regression появляется шаг-вопрос (шаг 2).
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('F-gen-crit'),
      criticality: 'CRITICAL',
      implemented: false,
      quarter: 'Q2',
      year: 2027,
    });

    await page.getByTestId('sidebar-open-tasks').click();
    const screen = page.getByTestId('export-tasks-modal');
    await expect(screen).toBeVisible();
    await expect(page.getByTestId('workspace-title')).toContainText('Генерация артефактов');

    // Шаг 1 активен, остальные — todo.
    await expect(page.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'todo');
    await expect(page.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'todo');

    // Направление crit-regression → шаг 2 «Способ и параметры» (шаблон + чекбоксы).
    await page.getByTestId('export-tasks-dir-crit-regression').click();
    await page.getByTestId('gen-direction-next').click();
    await expect(page.getByTestId('gen-mode')).toBeVisible();
    await expect(page.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'todo');

    // Вопрос о нереализованных ФТ стал чекбоксом на этом же шаге (макет Г4).
    await expect(page.getByTestId('gen-include-unimpl')).toBeChecked();

    // «Шаблон» → шаг 3 (результат) с именем файла и кнопкой «Скачать .md».
    await page.getByTestId('export-mode-template').click();
    await page.getByTestId('gen-template-start').click();
    await expect(page.getByTestId('gen-cases')).toBeVisible();
    await expect(page.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('export-tasks-filename')).toHaveText(
      /^crit-regression-\d{4}-\d{2}-\d{2}\.md$/,
    );
    await expect(page.getByTestId('export-tasks-download')).toContainText('Скачать .md');

    // «Изменить параметры» → на ПРЕДЫДУЩИЙ шаг (способ), а не на выбор направления.
    await page.getByTestId('gen-back-2').click();
    await expect(page.getByTestId('gen-mode')).toBeVisible();
    await expect(page.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'active');

    // «Назад» с шага 2 — на выбор направления.
    await page.getByTestId('gen-back-1').click();
    await expect(page.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('export-tasks-dir-tracker')).toBeVisible();
  });

  test('tracker: «Назад» из preview возвращает к выбору требований (пикеру)', async ({ page }) => {
    await createProject(page, uniqueName('gen-tracker-proj'));
    await addRequirement(page, { kind: 'function', name: uniqueName('F-gen-trk') });

    await page.getByTestId('sidebar-open-tasks').click();
    await page.getByTestId('export-tasks-dir-tracker').click();
    await page.getByTestId('gen-direction-next').click();
    await expect(page.getByTestId('tracker-select-modal')).toBeVisible();

    // Подтверждаем выбор → результат с именем файла tasks-*.md.
    await page.getByTestId('gen-select-confirm').click();
    await expect(page.getByTestId('gen-cases')).toBeVisible();
    await expect(page.getByTestId('export-tasks-filename')).toHaveText(
      /^tasks-\d{4}-\d{2}-\d{2}\.md$/,
    );

    // «Изменить выбор» из результата → предыдущий шаг: снова пикер.
    await page.getByTestId('gen-back-2').click();
    await expect(page.getByTestId('tracker-select-modal')).toBeVisible();
  });
});

test.describe('T4 · ConfirmDialog удаления требования (confirm-dialog.html)', () => {
  test('заголовок «Удалить требование?», сообщение среднего рода, отмена и удаление', async ({
    page,
  }) => {
    await createProject(page, uniqueName('del-dialog-proj'));
    const name = uniqueName('F-del-leaf');
    await addRequirement(page, { kind: 'function', name });

    const row = rowByName(page, name);
    await row.hover();
    await row.locator('[data-testid^="delete-btn-"]').click();
    const dialog = page.getByTestId('delete-dialog');
    await expect(dialog).toBeVisible();

    // Тексты по макету: заголовок-вопрос + средний род («будет удалено»).
    await expect(dialog).toContainText('Удалить требование?');
    const message = page.getByTestId('delete-dialog-message');
    await expect(message).toContainText(`«${name}» будет удалено`);
    await expect(message).toContainText('Действие необратимо');

    // Отмена ничего не удаляет.
    await page.getByTestId('delete-dialog-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    // Подтверждение удаляет строку.
    await row.hover();
    await row.locator('[data-testid^="delete-btn-"]').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('delete-dialog-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeHidden();
  });
});
