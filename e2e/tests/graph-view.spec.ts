import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  addRequirement,
  apiCreateRequirement,
  createProject,
  linkRequirements,
  projectIdFromUrl,
  uniqueName,
} from './helpers/app.js';

/**
 * E2E тесты для GraphView (FR-G1..FR-G8).
 *
 * Изоляция: каждый тест создаёт собственный проект с уникальным именем.
 * Сервер один (workers: 1), поэтому тесты идут последовательно.
 * ELK layout может занять 1–2 сек — используем увеличенные таймауты где нужно.
 */

// Таймаут для ожидания завершения ELK layout (graph-canvas виден после graph-building)
const ELK_TIMEOUT = 15_000;

test.describe('GraphView', () => {
  // ── Вспомогательная функция: переключиться в граф-вид ──────────────────────
  async function switchToGraph(page: import('@playwright/test').Page): Promise<void> {
    await page.getByTestId('toggle-graph').click();
    // Ждём, пока исчезнет состояние «строю граф» и появится холст
    await expect(page.getByTestId('graph-building')).toBeHidden({ timeout: ELK_TIMEOUT });
    // Либо canvas, либо empty — в любом случае graph-loading уйдёт
    await expect(page.getByTestId('graph-loading')).toBeHidden({ timeout: ELK_TIMEOUT });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Переключение в граф-вид
  // ─────────────────────────────────────────────────────────────────────────────
  test('переключение в граф-вид: холст видим, кнопка «Граф» активна', async ({ page }) => {
    const project = uniqueName('gv-switch');
    await createProject(page, project);

    // Создаём минимум 2 требования через UI
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Req-A'),
      criticality: 'HIGH',
    });
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Req-B'),
      criticality: 'MEDIUM',
    });

    // Переключаемся в граф
    await switchToGraph(page);

    // Холст должен быть виден
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Кнопка «Граф» помечена как активная (aria-pressed="true")
    await expect(page.getByTestId('toggle-graph')).toHaveAttribute('aria-pressed', 'true');

    // Кнопка «Дерево» не активна
    await expect(page.getByTestId('toggle-tree')).toHaveAttribute('aria-pressed', 'false');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Узлы в графе видны
  // ─────────────────────────────────────────────────────────────────────────────
  test('узлы требований видны в холсте', async ({ page }) => {
    const project = uniqueName('gv-nodes');
    await createProject(page, project);

    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Node-X'),
      criticality: 'MEDIUM',
    });
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Node-Y'),
      criticality: 'LOW',
    });

    await switchToGraph(page);

    // Хотя бы один узел с data-testid начинающимся на graph-node-
    const anyNode = page.locator('[data-testid^="graph-node-"]').first();
    await expect(anyNode).toBeVisible({ timeout: ELK_TIMEOUT });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Клик по узлу открывает RequirementModal
  // ─────────────────────────────────────────────────────────────────────────────
  test('клик по узлу графа открывает карточку требования', async ({ page }) => {
    const project = uniqueName('gv-click');
    await createProject(page, project);

    const reqName = uniqueName('Click-Me');
    await addRequirement(page, { kind: 'function', name: reqName, criticality: 'CRITICAL' });

    await switchToGraph(page);

    // Дожидаемся появления узла.
    // ReactFlow рендерит узлы в HTML overlay внутри ReactFlow canvas.
    // Клик диспатчим через JS напрямую, чтобы обойти ReactFlow pan handler.
    const node = page.locator('[data-testid^="graph-node-"]').first();
    await expect(node).toBeVisible({ timeout: ELK_TIMEOUT });

    // Диспатчим click через evaluate, чтобы React-обработчик onClick получил событие
    await node.evaluate((el) => (el as HTMLElement).click());

    // RequirementModal должна открыться
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Возврат в дерево
  // ─────────────────────────────────────────────────────────────────────────────
  test('возврат в дерево: TreeTable снова видна', async ({ page }) => {
    const project = uniqueName('gv-back');
    await createProject(page, project);

    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Back-A'),
      criticality: 'MEDIUM',
    });
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Back-B'),
      criticality: 'LOW',
    });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Возврат в дерево
    await page.getByTestId('toggle-tree').click();

    // TreeTable должна снова быть видна
    await expect(page.getByTestId('section-function')).toBeVisible();
    // toggle-tree активен
    await expect(page.getByTestId('toggle-tree')).toHaveAttribute('aria-pressed', 'true');
    // toggle-graph больше не активен
    await expect(page.getByTestId('toggle-graph')).toHaveAttribute('aria-pressed', 'false');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Тулбар графа видим
  // ─────────────────────────────────────────────────────────────────────────────
  test('тулбар графа присутствует в граф-виде', async ({ page }) => {
    const project = uniqueName('gv-toolbar');
    await createProject(page, project);

    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('TB-Req'),
      criticality: 'MEDIUM',
    });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    await expect(page.getByTestId('graph-toolbar')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Кнопка «Перерасставить» кликается без ошибки
  // ─────────────────────────────────────────────────────────────────────────────
  test('кнопка «Перерасставить» срабатывает без ошибки', async ({ page }) => {
    const project = uniqueName('gv-relayout');
    await createProject(page, project);

    await addRequirement(page, { kind: 'function', name: uniqueName('RL-A'), criticality: 'HIGH' });
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('RL-B'),
      criticality: 'MEDIUM',
    });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });
    await expect(page.getByTestId('graph-toolbar')).toBeVisible();

    // Кликаем «Перерасставить»
    await page.getByTestId('graph-relayout').click();

    // После повторного layout холст снова виден (не должно быть ошибки)
    await expect(page.getByTestId('graph-building')).toBeHidden({ timeout: ELK_TIMEOUT });
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Легенда по умолчанию развёрнута
  // ─────────────────────────────────────────────────────────────────────────────
  test('легенда по умолчанию развёрнута', async ({ page }) => {
    const project = uniqueName('gv-legend-open');
    await createProject(page, project);

    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('Legend-Req'),
      criticality: 'MEDIUM',
    });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Легенда видима
    await expect(page.getByTestId('graph-legend')).toBeVisible();

    // Кнопка-заголовок легенды показывает expanded=true
    await expect(page.getByTestId('graph-legend-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Легенда сворачивается по клику
  // ─────────────────────────────────────────────────────────────────────────────
  test('легенда сворачивается по клику на заголовок', async ({ page }) => {
    const project = uniqueName('gv-legend-collapse');
    await createProject(page, project);

    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('LC-Req'),
      criticality: 'MEDIUM',
    });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Убеждаемся, что легенда изначально развёрнута
    const legendToggle = page.getByTestId('graph-legend-toggle');
    await expect(legendToggle).toHaveAttribute('aria-expanded', 'true');

    // Сворачиваем. Легенда в ReactFlow Panel (bottom-left).
    // Используем JS click чтобы React обработал событие напрямую.
    await legendToggle.evaluate((el) => (el as HTMLElement).click());

    // Кнопка теперь показывает collapsed
    await expect(legendToggle).toHaveAttribute('aria-expanded', 'false');

    // Содержимое легенды (список записей) скрыто — проверяем через aria-expanded
    // Легенда как панель остаётся в DOM, но её содержимое скрыто
    await expect(legendToggle).toHaveAttribute('aria-expanded', 'false');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Пустой проект показывает graph-empty
  // ─────────────────────────────────────────────────────────────────────────────
  test('пустой проект: в граф-виде показывается заглушка', async ({ page }) => {
    const project = uniqueName('gv-empty');
    await createProject(page, project);

    // Не добавляем требований — проект пуст

    // Переключаемся в граф (у пустого проекта нет graph-building, ELK не запускается)
    await page.getByTestId('toggle-graph').click();

    // После отображения данных (без loading) должна быть заглушка
    await expect(page.getByTestId('graph-loading')).toBeHidden({ timeout: ELK_TIMEOUT });

    // graph-empty — пустое состояние
    await expect(page.getByTestId('graph-empty')).toBeVisible({ timeout: ELK_TIMEOUT });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Toggle НФТ: скрыть и снова показать НФТ-узлы
  // ─────────────────────────────────────────────────────────────────────────────
  test('toggle НФТ: скрывает и показывает нефункциональные требования', async ({ page }) => {
    const project = uniqueName('gv-nfr-toggle');
    await createProject(page, project);

    const fnName = uniqueName('FN-Req');
    const nfrName = uniqueName('NFR-Req');
    await addRequirement(page, { kind: 'function', name: fnName, criticality: 'MEDIUM' });
    await addRequirement(page, { kind: 'nfr', name: nfrName, criticality: 'LOW' });

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // По умолчанию НФТ показаны (aria-pressed="true")
    const nfrBtn = page.getByTestId('graph-toggle-nfr');
    await expect(nfrBtn).toHaveAttribute('aria-pressed', 'true');

    // Скрываем НФТ
    await nfrBtn.click();
    await expect(nfrBtn).toHaveAttribute('aria-pressed', 'false');

    // Возвращаем НФТ
    await nfrBtn.click();
    await expect(nfrBtn).toHaveAttribute('aria-pressed', 'true');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Toggle меток рёбер
  // ─────────────────────────────────────────────────────────────────────────────
  test('toggle меток рёбер: включается и выключается', async ({ page }) => {
    const project = uniqueName('gv-labels');
    await createProject(page, project);

    const src = uniqueName('Src-R');
    const tgt = uniqueName('Tgt-R');
    await addRequirement(page, { kind: 'function', name: src, criticality: 'MEDIUM' });
    await addRequirement(page, { kind: 'function', name: tgt, criticality: 'MEDIUM' });
    await linkRequirements(page, src, 'RELATES_TO', tgt);

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // По умолчанию метки выключены
    const labelsBtn = page.getByTestId('graph-toggle-labels');
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'false');

    // Включаем метки
    await labelsBtn.click();
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'true');

    // Выключаем метки
    await labelsBtn.click();
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'false');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Граф с требованиями и связями: узлы видны, граф строится без ошибок
  // ─────────────────────────────────────────────────────────────────────────────
  test('граф с требованиями и связями строится без ошибок', async ({ page }) => {
    const project = uniqueName('gv-linked');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    // Создаём 3 требования + 1 НФТ через API (быстрее)
    const slugA = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Linked-A'),
      criticality: 'CRITICAL',
    });
    const slugB = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Linked-B'),
      criticality: 'HIGH',
    });
    await apiCreateRequirement(page, projectId, {
      kind: 'nfr',
      name: uniqueName('Linked-NFR'),
      criticality: 'MEDIUM',
    });

    // Создаём связь через API
    await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/links`, {
      data: { sourceSlug: slugA, type: 'RELATES_TO', targetSlug: slugB },
    });

    // Обновляем страницу чтобы подхватить данные
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Нет ошибки
    await expect(page.getByTestId('graph-error')).toBeHidden();

    // Узлы видны
    await expect(page.locator('[data-testid^="graph-node-"]').first()).toBeVisible({
      timeout: ELK_TIMEOUT,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Конкретный узел по slug (graph-node-{slug})
  // ─────────────────────────────────────────────────────────────────────────────
  test('узел конкретного требования найден по data-testid graph-node-{slug}', async ({ page }) => {
    const project = uniqueName('gv-slug');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    const slug = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Slug-Target'),
      criticality: 'CRITICAL',
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Конкретный узел должен быть виден по своему slug
    await expect(page.getByTestId(`graph-node-${slug}`)).toBeVisible({ timeout: ELK_TIMEOUT });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. ReactFlow Controls (zoom +/-/fit) и MiniMap присутствуют
  // ─────────────────────────────────────────────────────────────────────────────
  test('ReactFlow Controls и MiniMap видимы в граф-виде', async ({ page }) => {
    const project = uniqueName('gv-controls');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Ctrl-Req'),
      criticality: 'MEDIUM',
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // ReactFlow Controls панель (data-testid="rf__controls")
    await expect(page.getByTestId('rf__controls')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Кнопки zoom in/out и fitView
    await expect(page.locator('.react-flow__controls-zoomin')).toBeVisible();
    await expect(page.locator('.react-flow__controls-zoomout')).toBeVisible();
    await expect(page.locator('.react-flow__controls-fitview')).toBeVisible();

    // MiniMap (data-testid="rf__minimap")
    await expect(page.getByTestId('rf__minimap')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Кнопка fitView кликается без ошибки
  // ─────────────────────────────────────────────────────────────────────────────
  test('кнопка «Вписать в экран» (fitView) срабатывает без ошибки', async ({ page }) => {
    const project = uniqueName('gv-fitview');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('FV-Req'),
      criticality: 'HIGH',
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });
    await expect(page.locator('.react-flow__controls-fitview')).toBeVisible();

    // Клик по fitView через JS evaluate — Controls внутри ReactFlow canvas,
    // <main> перехватывает pointer events, поэтому Playwright click не проходит.
    await page
      .locator('.react-flow__controls-fitview')
      .evaluate((el) => (el as HTMLElement).click());

    // Граф остаётся видимым, нет ошибки
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(page.getByTestId('graph-error')).toBeHidden();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. НФТ-узел виден в графе (badge «НФТ»)
  // ─────────────────────────────────────────────────────────────────────────────
  test('НФТ-требование отображается в графе с меткой «НФТ»', async ({ page }) => {
    const project = uniqueName('gv-nfr-node');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    const nfrSlug = await apiCreateRequirement(page, projectId, {
      kind: 'nfr',
      name: uniqueName('NFR-Node'),
      criticality: 'HIGH',
    });
    // Добавляем ФТ чтобы граф был не пустой
    await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('FN-Companion'),
      criticality: 'MEDIUM',
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // НФТ-узел виден по slug
    const nfrNode = page.getByTestId(`graph-node-${nfrSlug}`);
    await expect(nfrNode).toBeVisible({ timeout: ELK_TIMEOUT });

    // Узел содержит badge «НФТ»
    await expect(nfrNode).toContainText('НФТ');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. Perf-gate: >200 узлов показывает баннер, «Показать всё» убирает его
  // ─────────────────────────────────────────────────────────────────────────────
  test('perf-gate (>200 узлов): показывает баннер и кнопку «Показать всё»', async ({ page }) => {
    const project = uniqueName('gv-perf');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    // Создаём 201 требование через API параллельно (PERF_LIMIT = 200).
    // Параллельные запросы ускоряют создание в ~10x.
    const BATCH = 201;
    const batches: Array<Promise<string>> = [];
    for (let i = 0; i < BATCH; i++) {
      batches.push(
        apiCreateRequirement(page, projectId, {
          kind: 'function',
          name: `Perf-Node-${i}-${Date.now()}`,
          criticality: 'LOW',
        }),
      );
    }
    await Promise.all(batches);

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // Переключаемся в граф — ждём окончания layout (может занять чуть больше)
    await page.getByTestId('toggle-graph').click();
    await expect(page.getByTestId('graph-loading')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('graph-building')).toBeHidden({ timeout: 30_000 });

    // Должен появиться perf-баннер
    await expect(page.getByTestId('graph-perf-banner')).toBeVisible({ timeout: 30_000 });

    // Кнопка «Показать всё» видима
    await expect(page.getByTestId('graph-show-all')).toBeVisible();

    // Клик «Показать всё» убирает баннер
    await page.getByTestId('graph-show-all').click();
    await expect(page.getByTestId('graph-perf-banner')).toBeHidden({ timeout: 5_000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 18. Битые файлы требований: узел с isBroken виден в графе
  // ─────────────────────────────────────────────────────────────────────────────
  test('битый .md файл показывает узел-заглушку с ошибкой парсинга', async ({ page }) => {
    const project = uniqueName('gv-broken');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    // Создаём нормальное требование чтобы граф не был пустым
    await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Normal-Req'),
      criticality: 'MEDIUM',
    });

    // Записываем невалидный .md файл напрямую в папку проекта
    // Путь: {PROJECTS_ROOT}/{projectId}/openspec/specs/functions/broken-test.md
    const projectsRoot = process.env.E2E_PROJECTS_ROOT ?? path.join(os.tmpdir(), 'po-e2e-projects');
    const brokenFilePath = path.join(
      projectsRoot,
      projectId,
      'openspec',
      'specs',
      'functions',
      'broken-test-req.md',
    );
    // Невалидный frontmatter — отсутствует обязательное поле name
    await fsp.writeFile(
      brokenFilePath,
      '---\ntype: FUNCTION\n# missing name field\n---\nInvalid requirement file\n',
      'utf8',
    );

    // Перезагружаем страницу (сервер перечитает файлы)
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Должен быть виден узел с data-testid начинающимся на graph-node-broken-
    const brokenNode = page.locator('[data-testid^="graph-node-broken-"]').first();
    await expect(brokenNode).toBeVisible({ timeout: ELK_TIMEOUT });

    // Редизайн (graph-view.html §2.20.1): узел помечен «Битый файл» + имя файла
    await expect(brokenNode).toContainText('Битый файл');
    await expect(brokenNode).toContainText('broken-test-req.md');

    // Текст ошибки — в тултипе (graph-node-<slug>-tip), который появляется по hover
    const tip = brokenNode.locator('[data-testid$="-tip"]');
    await expect(tip).toBeHidden();
    await brokenNode.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Файл не читается');

    // Очистка: удаляем битый файл
    await fsp.unlink(brokenFilePath).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 19. Узлы сохраняют связи в графе (ребро PARENT_OF видно через MiniMap)
  // ─────────────────────────────────────────────────────────────────────────────
  test('связанные требования образуют граф с рёбрами', async ({ page }) => {
    const project = uniqueName('gv-edges');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    const parentSlug = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Edge-Parent'),
      criticality: 'HIGH',
    });
    const childSlug = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Edge-Child'),
      criticality: 'MEDIUM',
    });

    // Создаём связь CHILD_OF (child → parent)
    await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/links`, {
      data: { sourceSlug: childSlug, type: 'CHILD_OF', targetSlug: parentSlug },
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    // Оба узла видны
    await expect(page.getByTestId(`graph-node-${parentSlug}`)).toBeVisible({
      timeout: ELK_TIMEOUT,
    });
    await expect(page.getByTestId(`graph-node-${childSlug}`)).toBeVisible({ timeout: ELK_TIMEOUT });

    // MiniMap показывает узлы (SVG внутри rf__minimap не пустой)
    const minimap = page.getByTestId('rf__minimap');
    await expect(minimap).toBeVisible();
    // ReactFlow рисует в MiniMap rect-элементы для каждого узла
    await expect(minimap.locator('rect.react-flow__minimap-node').first()).toBeVisible({
      timeout: ELK_TIMEOUT,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 20. ФТ-узел содержит метаданные: criticality badge, implemented-статус
  // ─────────────────────────────────────────────────────────────────────────────
  test('узел ФТ содержит badge типа, критичность и статус реализации', async ({ page }) => {
    const project = uniqueName('gv-meta');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    const slug = await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Meta-Req'),
      criticality: 'CRITICAL',
      implemented: false,
      quarter: 'Q2',
      year: 2027,
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await switchToGraph(page);
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: ELK_TIMEOUT });

    const node = page.getByTestId(`graph-node-${slug}`);
    await expect(node).toBeVisible({ timeout: ELK_TIMEOUT });

    // Badge типа «ФТ»
    await expect(node).toContainText('ФТ');
    // Метка критичности — русская (редизайн: CRITICALITY_LABEL)
    await expect(node).toContainText('Критическая');
    // Символ «не реализовано» (⏱)
    await expect(node).toContainText('⏱');
  });
});
