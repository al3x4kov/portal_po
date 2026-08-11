import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AI_TESTGEN_BATCH, type AiGenerateTestsRequest } from '@po/core';
import { GeneratePage } from './GeneratePage';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

/**
 * Полноэкранный мастер генерации артефактов — все клиентские пути макетов
 * Г1–Г12: направления с охватом, ветка TaskTracker, развилка «Шаблон / AI»,
 * незаданный AI, прогон, остановка, ошибка батча, оба результата,
 * подтверждение прерывания и нулевой охват.
 */

const getProject = vi.fn();
const listRequirements = vi.fn();
const getConfig = vi.fn();
const listModels = vi.fn();
const generateTests = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: { get: (...a: unknown[]) => getProject(...a) },
  requirementsApi: { list: (...a: unknown[]) => listRequirements(...a) },
  linksApi: {},
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    listModels: (...a: unknown[]) => listModels(...a),
    generateTests: (...a: unknown[]) => generateTests(...a),
  },
}));

const ftA = makeReq({
  slug: 'ft-a',
  name: 'Вход по паролю',
  criticality: 'BLOCKER',
  description: 'Пользователь входит по email и паролю.',
  links: [],
});
const ftB = makeReq({
  slug: 'ft-b',
  name: 'Выход из системы',
  criticality: 'HIGH',
  description: 'Завершение сессии.',
  links: [],
});
const ftPlanned = makeReq({
  slug: 'ft-plan',
  name: 'Вход по биометрии',
  criticality: 'MEDIUM',
  implemented: false,
  targetQuarter: 'Q3',
  targetYear: 2026,
  links: [],
});
const nfr = makeReq({ slug: 'nfr-a', name: 'Доступность', type: 'NFR', links: [] });

const requirements = [ftA, ftB, ftPlanned, nfr];

const CASE_A = {
  slug: 'ft-a',
  title: 'Вход с валидными данными',
  goal: 'Проверить вход',
  precondition: 'Пользователь зарегистрирован',
  steps: ['Открыть форму входа', 'Ввести email и пароль'],
  expected: 'Открыт главный экран',
};

function renderPage(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/generate" element={<GeneratePage />} />
      <Route path="/p/:id" element={<div data-testid="tree-screen" />} />
      <Route path="/p/:id/ai" element={<div data-testid="ai-settings-screen" />} />
    </Routes>,
    { route: '/p/p1/generate' },
  );
}

/** Обещание, которым тест управляет вручную: «батч завис в модели». */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 25 однотипных ФТ → три батча по ≤10: есть что останавливать посередине. */
function manyRequirements(): ReturnType<typeof makeReq>[] {
  return Array.from({ length: 25 }, (_, i) =>
    makeReq({ slug: `f${i}`, name: `ФТ ${i}`, criticality: 'HIGH', links: [] }),
  );
}

/** Дойти до шага «Способ и параметры» для указанного направления. */
async function gotoMode(
  user: ReturnType<typeof userEvent.setup>,
  dir: 'smoke' | 'crit-regression' | 'full' = 'smoke',
): Promise<void> {
  renderPage();
  await screen.findByTestId(`export-tasks-dir-${dir}`);
  await user.click(screen.getByTestId(`export-tasks-dir-${dir}`));
  await user.click(screen.getByTestId('gen-direction-next'));
  if (dir === 'smoke') {
    // Smoke идёт через промежуточный «Состав модели» — подтверждаем целиком.
    await screen.findByTestId('gen-compose');
    await user.click(screen.getByTestId('gen-compose-next'));
  }
  await screen.findByTestId('gen-mode');
}

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({ id: 'p1', name: 'Twitter', mainPath: '/Projects/Twitter' });
  listRequirements.mockResolvedValue({ requirements, broken: [] });
  getConfig.mockResolvedValue({
    baseURL: 'https://hub.test/v1',
    hasApiKey: true,
    model: 'DeepSeek-V4-Flash',
  });
  listModels.mockResolvedValue({ models: ['DeepSeek-V4-Flash', 'GigaChat-2-Max'] });
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

// ── Г1 · шаг «Направление» ──────────────────────────────────────────────────

describe('Г1 — направление', () => {
  it('показывает 4 направления с живым охватом и панель «Что вы получите»', async () => {
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    for (const dir of ['tracker', 'smoke', 'crit-regression', 'full']) {
      expect(screen.getByTestId(`export-tasks-dir-${dir}`)).toBeInTheDocument();
    }
    // ФТ всего 3; в смок попадают все (BLOCKER/HIGH + корни + нереализованное).
    await waitFor(() =>
      expect(screen.getByTestId('gen-coverage-smoke')).toHaveTextContent('охват: 3 из 3 ФТ'),
    );
    expect(screen.getByTestId('gen-coverage-full')).toHaveTextContent('охват: 3 из 3 ФТ');
    expect(screen.getByTestId('gen-coverage-tracker')).toHaveTextContent('вручную');
  });

  it('правая панель меняется вместе с выбранным направлением', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    expect(screen.getByTestId('gen-sample')).toHaveTextContent('tc-id: SMK-001');
    await user.click(screen.getByTestId('export-tasks-dir-full'));
    expect(screen.getByTestId('gen-sample')).toHaveTextContent('tc-id: FUL-001');
  });

  it('степпер отмечает пройденные шаги и подсвечивает активный', async () => {
    const user = userEvent.setup();
    // Смок теперь идёт через 4 шага: «Состав модели» вторым.
    await gotoMode(user);
    expect(screen.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('gen-step-2')).toHaveTextContent('Состав модели');
    expect(screen.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('gen-step-4')).toHaveAttribute('data-state', 'todo');
  });
});

// ── Г2 · ветка TaskTracker ──────────────────────────────────────────────────

describe('Г2 — ветка «Задачи в TaskTracker»', () => {
  it('ведёт на выбор требований тем же деревом и собирает задачи', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-tracker');
    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await user.click(screen.getByTestId('gen-direction-next'));

    await screen.findByTestId('tracker-select-modal');
    expect(screen.getByTestId('gen-select-count')).toHaveTextContent('4');

    await user.click(screen.getByTestId('gen-select-confirm'));
    const preview = await screen.findByTestId('gen-cases');
    expect(preview).toHaveTextContent('Вход по паролю');
    expect(screen.getByTestId('export-tasks-filename')).toHaveTextContent('tasks-');
  });

  it('снятые требования не попадают в задачи вместе со связями на них', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-tracker');
    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('tracker-select-modal');

    const row = screen.getByTestId('export-item-ft-b');
    await user.click(row.querySelector('input[type="checkbox"]') as HTMLElement);
    expect(screen.getByTestId('gen-select-count')).toHaveTextContent('3');

    await user.click(screen.getByTestId('gen-select-confirm'));
    await user.click(await screen.findByTestId('gen-view-markdown'));
    const md = screen.getByTestId('export-tasks-preview');
    expect(md).toHaveTextContent('Вход по паролю');
    expect(md).not.toHaveTextContent('Выход из системы');
  });

  it('«Сформировать» заблокирована, пока ничего не выбрано', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-tracker');
    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('tracker-select-modal');
    await user.click(screen.getByTestId('export-untoggle-all'));
    expect(screen.getByTestId('gen-select-confirm')).toBeDisabled();
  });
});

// ── Г3/Г4 · развилка способа ────────────────────────────────────────────────

describe('Г3/Г4 — способ и параметры', () => {
  it('Г3: «Шаблон» показывает только свои параметры и собирает документ без AI', async () => {
    const user = userEvent.setup();
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-template'));
    expect(screen.queryByTestId('gen-ai-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent('мгновенно');

    await user.click(screen.getByTestId('gen-template-start'));
    await screen.findByTestId('gen-cases');
    expect(generateTests).not.toHaveBeenCalled();
    expect(screen.getByTestId('gen-template-note')).toHaveTextContent('Детерминированная сборка');
  });

  it('Г4: «AI» показывает модель, чекбокс негативов (смок) и мини-смету', async () => {
    const user = userEvent.setup();
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    expect(await screen.findByTestId('gen-ai-model-select')).toHaveValue('DeepSeek-V4-Flash');
    expect(screen.getByTestId('gen-ai-negatives')).not.toBeChecked();
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent(`1 батча по ≤${AI_TESTGEN_BATCH}`);
  });

  it('Г4: чекбокс негативов есть только у смока', async () => {
    const user = userEvent.setup();
    await gotoMode(user, 'full');
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    expect(screen.queryByTestId('gen-ai-negatives')).not.toBeInTheDocument();
  });

  it('Г4: вопрос о нереализованных ФТ стал чекбоксом и сужает охват', async () => {
    const user = userEvent.setup();
    await gotoMode(user, 'crit-regression');
    // Нереализованное ФТ одно — оно и попадает в крит-регресс вместе с блокером.
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent('2 из 3 ФТ');
    await user.click(screen.getByTestId('gen-include-unimpl'));
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent('1 из 3 ФТ');
  });

  it('смок: шаг «Состав модели» показывает принцип отбора и причину попадания каждого ФТ', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    expect(screen.getByTestId('gen-direction-next')).toHaveTextContent('Далее: состав модели');
    await user.click(screen.getByTestId('gen-direction-next'));

    // Принцип отбора виден словами, не только счётчиком.
    const compose = await screen.findByTestId('gen-compose');
    expect(screen.getByTestId('gen-compose-aside')).toHaveTextContent(
      'Критичность Блокер/Критическая/Высокая, корни дерева и нереализованные ФТ',
    );
    // Все три отобранных ФТ показаны с причинами.
    expect(compose.querySelectorAll('[data-testid^="gen-compose-row-"]')).toHaveLength(3);
    const ftAReasons = screen.getAllByTestId('gen-compose-reason-ft-a').map((el) => el.textContent);
    expect(ftAReasons).toContain('высокая критичность');
    expect(ftAReasons).toContain('корень дерева');
    const plannedReasons = screen
      .getAllByTestId('gen-compose-reason-ft-plan')
      .map((el) => el.textContent);
    expect(plannedReasons).toContain('не реализовано');
    // Сводка честная: отобрано правилом / исключено / войдут.
    expect(screen.getByTestId('gen-compose-summary')).toHaveTextContent('3 из 3 ФТ');
    expect(screen.getByTestId('gen-compose-included')).toHaveTextContent('3');
  });

  it('смок: исключённое на «Составе модели» ФТ не попадает в смету и в собранный файл', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('gen-compose');

    // Исключаем «Выход из системы»; счётчики и кнопка пересчитываются.
    await user.click(screen.getByTestId('gen-compose-check-ft-b'));
    expect(screen.getByTestId('gen-compose-excluded')).toHaveTextContent('1');
    expect(screen.getByTestId('gen-compose-included')).toHaveTextContent('2');
    expect(screen.getByTestId('gen-compose-next')).toHaveTextContent('(2)');

    await user.click(screen.getByTestId('gen-compose-next'));
    await screen.findByTestId('gen-mode');
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent('2 из 3 ФТ');

    // Шаблонная сборка уважает исключение.
    await user.click(screen.getByTestId('export-mode-template'));
    await user.click(screen.getByTestId('gen-template-start'));
    await screen.findByTestId('gen-cases');
    const markdown = screen.getByTestId('gen-cases').textContent ?? '';
    expect(markdown).toContain('Вход по паролю');
    expect(markdown).not.toContain('Выход из системы');
  });

  it('смок: исключить все ФТ нельзя — «Далее» блокируется; «Вернуть исключённые» возвращает всё', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('gen-compose');

    await user.click(screen.getByTestId('gen-compose-check-ft-a'));
    await user.click(screen.getByTestId('gen-compose-check-ft-b'));
    await user.click(screen.getByTestId('gen-compose-check-ft-plan'));
    expect(screen.getByTestId('gen-compose-next')).toBeDisabled();

    await user.click(screen.getByTestId('gen-compose-reset'));
    expect(screen.getByTestId('gen-compose-included')).toHaveTextContent('3');
    expect(screen.getByTestId('gen-compose-next')).toBeEnabled();
  });

  it('смок: «Назад» с шага способа возвращает на «Состав модели», исключения сохранены', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-smoke');
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('gen-compose');
    await user.click(screen.getByTestId('gen-compose-check-ft-b'));
    await user.click(screen.getByTestId('gen-compose-next'));
    await screen.findByTestId('gen-mode');

    await user.click(screen.getByTestId('gen-back-1'));
    await screen.findByTestId('gen-compose');
    expect(screen.getByTestId('gen-compose-check-ft-b')).not.toBeChecked();
    expect(screen.getByTestId('gen-compose-excluded')).toHaveTextContent('1');
  });

  it('крит-регресс и полная модель идут на способ без шага состава', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('export-tasks-dir-crit-regression');
    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    expect(screen.getByTestId('gen-direction-next')).toHaveTextContent('Далее: способ и параметры');
    await user.click(screen.getByTestId('gen-direction-next'));
    await screen.findByTestId('gen-mode');
    expect(screen.queryByTestId('gen-compose')).not.toBeInTheDocument();
  });

  it('фильтр «только реализованные» доступен и в режиме шаблона: без галочки в модель не попадает ни одно нереализованное ФТ', async () => {
    const user = userEvent.setup();
    await gotoMode(user, 'smoke');
    await user.click(screen.getByTestId('export-mode-template'));
    // Чекбокс живёт на шаге способа НЕЗАВИСИМО от выбранного режима.
    const checkbox = screen.getByTestId('gen-include-unimpl');
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    // Смок без нереализованных: остаются только реализованные BLOCKER/HIGH.
    expect(screen.getByTestId('gen-estimate')).toHaveTextContent('2 из 3 ФТ');

    await user.click(screen.getByTestId('gen-template-start'));
    await screen.findByTestId('gen-cases');
    const markdown = screen.getByTestId('gen-cases').textContent ?? '';
    expect(markdown).toContain('Вход по паролю');
    expect(markdown).toContain('Выход из системы');
    // Запланированное (нереализованное) ФТ явно исключено из выгрузки.
    expect(markdown).not.toContain('Вход по биометрии');
  });
});

// ── Г5 · негатив: AI не настроен ────────────────────────────────────────────

describe('Г5 — AI не настроен', () => {
  beforeEach(() => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false, model: '' });
  });

  it('карточка AI заблокирована, есть переход в настройку и путь через шаблон', async () => {
    const user = userEvent.setup();
    await gotoMode(user);
    expect(await screen.findByTestId('gen-ai-not-configured')).toHaveTextContent(
      'Укажите ключ AI-хаба',
    );
    expect(screen.getByTestId('export-mode-ai')).toBeDisabled();
    // Тупика нет: шаблон доступен прямо сейчас.
    expect(screen.getByTestId('gen-template-start')).toBeEnabled();

    await user.click(screen.getByTestId('gen-open-ai-settings'));
    await screen.findByTestId('ai-settings-screen');
  });
});

// ── Г6/Г9 · прогон и успешный результат ─────────────────────────────────────

describe('Г6/Г9 — прогон AI и результат', () => {
  it('батчи, журнал, счётчики проверки и карточки кейсов с бейджем происхождения', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 1, missing: ['ft-b'] });
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));

    await waitFor(() => expect(generateTests).toHaveBeenCalledTimes(1));
    const req = generateTests.mock.calls[0]?.[0] as AiGenerateTestsRequest;
    expect(req.kind).toBe('smoke');
    expect(req.model).toBe('DeepSeek-V4-Flash');
    expect(req.negatives).toBe(false);

    // Результат: кейс модели + достроенные шаблоном.
    const cases = await screen.findByTestId('gen-cases');
    expect(cases).toHaveTextContent('Вход с валидными данными');
    await waitFor(() =>
      expect(screen.getByTestId('gen-case-SMK-001')).toHaveAttribute('data-source', 'ai'),
    );
    expect(screen.getByTestId('gen-case-SMK-002')).toHaveAttribute('data-source', 'template');

    expect(screen.getByTestId('gen-badge-ai')).toHaveTextContent('AI-кейсов: 1');
    expect(screen.getByTestId('gen-badge-fallback')).toHaveTextContent('достроено шаблоном: 2');
    expect(screen.getByTestId('gen-badge-dropped')).toHaveTextContent('галлюцинаций отброшено: 1');

    const log = screen.getByTestId('gen-ai-log');
    expect(log).toHaveTextContent('Батч 1/1');
    expect(log).toHaveTextContent('без кейса (достроим шаблоном): «Выход из системы»');
    expect(log).toHaveTextContent('Готово: AI-кейсов 1');
  });

  it('карточка раскрывается по клику, есть переключатель на сырой markdown', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 0, missing: [] });
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));
    await screen.findByTestId('gen-case-SMK-001');

    await user.click(screen.getByText('Вход с валидными данными'));
    expect(screen.getByTestId('gen-case-SMK-001')).toHaveTextContent('Открыть форму входа');

    await user.click(screen.getByTestId('gen-view-markdown'));
    expect(screen.getByTestId('export-tasks-preview')).toHaveTextContent('source: ai');
  });

  it('«Скачать .md» собирает blob, кликает временный якорь и отзывает URL', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 0, missing: [] });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));
    await screen.findByTestId('gen-case-SMK-001');

    await user.click(screen.getByTestId('export-tasks-download'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    clickSpy.mockRestore();
  });

  it('«Изменить параметры» возвращает на шаг способа, журнал сохраняется', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 0, missing: [] });
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));
    await screen.findByTestId('gen-case-SMK-001');

    await user.click(screen.getByTestId('gen-back-2'));
    expect(await screen.findByTestId('gen-mode')).toBeInTheDocument();
    // Возврат на результат — журнал прежнего прогона на месте.
    await user.click(screen.getByTestId('gen-ai-start'));
    expect(await screen.findByTestId('gen-ai-log')).toHaveTextContent('Батч 1/1');
  });
});

// ── Г7 · негатив: остановка пользователем ───────────────────────────────────

describe('Г7 — остановка пользователем', () => {
  it('останавливает прогон, сохраняет готовое и предлагает продолжить или достроить', async () => {
    const user = userEvent.setup();
    listRequirements.mockResolvedValue({ requirements: manyRequirements(), broken: [] });

    // Второй батч «висит» в модели — успеваем нажать «Остановить».
    const hang = deferred<{ cases: unknown[]; dropped: number; missing: string[] }>();
    let call = 0;
    generateTests.mockImplementation((req: AiGenerateTestsRequest) => {
      call += 1;
      const answer = {
        cases: req.slugs.map((s) => ({ ...CASE_A, slug: s })),
        dropped: 0,
        missing: [],
      };
      if (call === 2) return hang.promise;
      return Promise.resolve(answer);
    });

    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));

    await waitFor(() => expect(generateTests).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId('gen-ai-stop'));
    hang.resolve({
      cases: (generateTests.mock.calls[1]?.[0] as AiGenerateTestsRequest).slugs.map((s) => ({
        ...CASE_A,
        slug: s,
      })),
      dropped: 0,
      missing: [],
    });

    const banner = await screen.findByTestId('gen-stopped-banner');
    expect(banner).toHaveTextContent('Генерация остановлена');
    expect(screen.getByTestId('gen-ai-resume')).toHaveTextContent('Продолжить генерацию (батч 3/');
    expect(screen.getByTestId('gen-ai-fill-template')).toHaveTextContent('шаблоном');
    expect(screen.getByTestId('export-tasks-download')).toHaveTextContent('Скачать частичный .md');
    expect(screen.getByTestId('gen-ai-log')).toHaveTextContent('Остановлено пользователем');
    // Третий батч не отправлялся — работа остановлена, а не доведена до конца.
    expect(generateTests).toHaveBeenCalledTimes(2);
  });

  it('«Достроить шаблоном» закрывает прогон без потери покрытия', async () => {
    const user = userEvent.setup();
    listRequirements.mockResolvedValue({ requirements: manyRequirements(), broken: [] });

    const hang = deferred<{ cases: unknown[]; dropped: number; missing: string[] }>();
    let call = 0;
    generateTests.mockImplementation((req: AiGenerateTestsRequest) => {
      call += 1;
      if (call === 2) return hang.promise;
      return Promise.resolve({
        cases: req.slugs.map((s) => ({ ...CASE_A, slug: s })),
        dropped: 0,
        missing: [],
      });
    });

    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));
    await waitFor(() => expect(generateTests).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId('gen-ai-stop'));
    hang.resolve({ cases: [], dropped: 0, missing: [] });
    await screen.findByTestId('gen-stopped-banner');

    await user.click(screen.getByTestId('gen-ai-fill-template'));
    await waitFor(() => expect(screen.queryByTestId('gen-stopped-banner')).not.toBeInTheDocument());
    // Все 25 требований оказались в документе: часть от AI, часть шаблоном.
    expect(screen.getByTestId('gen-case-SMK-025')).toBeInTheDocument();
    expect(screen.getByTestId('gen-case-SMK-025')).toHaveAttribute('data-source', 'template');
    expect(screen.getByTestId('gen-ai-log')).toHaveTextContent('Достроено шаблоном');
  });
});

// ── Г8 · негатив: ошибка батча ──────────────────────────────────────────────

describe('Г8 — ошибка батча', () => {
  it('сбойный батч не останавливает очередь: остальные проходят, повтор — точечный', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 15 }, (_, i) =>
      makeReq({ slug: `f${i}`, name: `ФТ ${i}`, criticality: 'HIGH', links: [] }),
    );
    listRequirements.mockResolvedValue({ requirements: many, broken: [] });

    // Падает ТОЛЬКО второй батч; остальные обязаны отработать.
    let call = 0;
    generateTests.mockImplementation((req: AiGenerateTestsRequest) => {
      call += 1;
      if (call === 2) return Promise.reject(new Error('Тайм-аут модели (30 с)'));
      return Promise.resolve({
        cases: req.slugs.map((s) => ({ ...CASE_A, slug: s })),
        dropped: 0,
        missing: [],
      });
    });

    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));

    const banner = await screen.findByTestId('gen-error-banner');
    expect(banner).toHaveTextContent('Не удалось батчей: 1');
    // Очередь пройдена целиком — вызовов столько же, сколько батчей.
    const totalBatches = Math.ceil(15 / AI_TESTGEN_BATCH);
    await waitFor(() => expect(generateTests).toHaveBeenCalledTimes(totalBatches));
    expect(screen.getByTestId('gen-ai-log')).toHaveTextContent('продолжаем со следующего');
    expect(screen.getByTestId('gen-ai-log')).toHaveTextContent('Тайм-аут модели');

    // Повтор адресный: только сбойный батч, а не весь прогон заново.
    await user.click(screen.getByTestId('gen-ai-resume'));
    await waitFor(() => expect(generateTests).toHaveBeenCalledTimes(totalBatches + 1));
    const retried = generateTests.mock.calls[totalBatches]![0] as AiGenerateTestsRequest;
    const secondBatch = (generateTests.mock.calls[1]![0] as AiGenerateTestsRequest).slugs;
    expect(retried.slugs).toEqual(secondBatch);
  });

  it('кнопка повтора называет число неудавшихся батчей', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 15 }, (_, i) =>
      makeReq({ slug: `f${i}`, name: `ФТ ${i}`, criticality: 'HIGH', links: [] }),
    );
    listRequirements.mockResolvedValue({ requirements: many, broken: [] });
    generateTests.mockRejectedValue(new Error('AI Hub недоступен'));

    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));

    const totalBatches = Math.ceil(15 / AI_TESTGEN_BATCH);
    expect(await screen.findByTestId('gen-ai-resume')).toHaveTextContent(
      `Повторить неудавшиеся батчи (${totalBatches})`,
    );
    // Даже когда не далось ничего, покрытие спасается шаблоном.
    expect(screen.getByTestId('gen-ai-fill-template')).toBeInTheDocument();
  });
});

// ── Г10 · результат по шаблону ──────────────────────────────────────────────

describe('Г10 — результат по шаблону', () => {
  it('все кейсы помечены шаблоном, панели галлюцинаций нет, есть «Пересобрать»', async () => {
    const user = userEvent.setup();
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-template'));
    await user.click(screen.getByTestId('gen-template-start'));

    await screen.findByTestId('gen-cases');
    expect(screen.getByTestId('gen-case-SMK-001')).toHaveAttribute('data-source', 'template');
    expect(screen.queryByTestId('gen-verify-badges')).not.toBeInTheDocument();
    expect(screen.getByTestId('gen-regenerate')).toHaveTextContent('Пересобрать');
  });
});

// ── Г11 · подтверждение прерывания ──────────────────────────────────────────

describe('Г11 — уход со страницы во время прогона', () => {
  /** Запустить AI-прогон и оставить его «висеть» в первом батче. */
  async function startHangingRun(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    listRequirements.mockResolvedValue({ requirements: manyRequirements(), broken: [] });
    generateTests.mockImplementation(() => new Promise(() => {}));
    await gotoMode(user);
    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai-model-select');
    await user.click(screen.getByTestId('gen-ai-start'));
    await waitFor(() => expect(generateTests).toHaveBeenCalled());
    await screen.findByTestId('gen-ai-stop');
  }

  it('перехватывает переход подтверждением; «Остаться» держит на экране', async () => {
    const user = userEvent.setup();
    await startHangingRun(user);

    await user.click(screen.getByTestId('workspace-back'));
    expect(await screen.findByText('Прервать генерацию?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Остаться' }));
    await waitFor(() => expect(screen.queryByText('Прервать генерацию?')).not.toBeInTheDocument());
    expect(screen.queryByTestId('tree-screen')).not.toBeInTheDocument();
  });

  it('переход по сайдбару во время прогона тоже спрашивает подтверждение', async () => {
    const user = userEvent.setup();
    await startHangingRun(user);
    await user.click(screen.getByTestId('sidebar-nav-dashboard'));
    expect(await screen.findByText('Прервать генерацию?')).toBeInTheDocument();
  });

  it('«Прервать» уводит к дереву требований', async () => {
    const user = userEvent.setup();
    await startHangingRun(user);

    await user.click(screen.getByTestId('workspace-back'));
    await user.click(await screen.findByRole('button', { name: 'Прервать' }));
    await screen.findByTestId('tree-screen');
  });
});

// ── Г12 · негатив: нулевой охват ────────────────────────────────────────────

describe('Г12 — нулевой охват направления', () => {
  it('красный бейдж, заблокированное «Далее» и объяснение с переходом к требованиям', async () => {
    const user = userEvent.setup();
    // Ни одного ФТ уровня Блокер/Критическая, всё реализовано, широких веток нет.
    listRequirements.mockResolvedValue({
      requirements: [makeReq({ slug: 'f1', name: 'Мелочь', criticality: 'LOW', links: [] })],
      broken: [],
    });
    renderPage();
    await screen.findByTestId('export-tasks-dir-crit-regression');
    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));

    expect(screen.getByTestId('gen-coverage-crit-regression')).toHaveTextContent(
      'охват: 0 из 1 ФТ',
    );
    expect(screen.getByTestId('gen-direction-next')).toBeDisabled();
    expect(screen.getByTestId('gen-empty-coverage')).toHaveTextContent(
      'Под правила отбора не попало ни одно ФТ',
    );

    await user.click(screen.getByTestId('gen-open-requirements'));
    await screen.findByTestId('tree-screen');
  });
});
