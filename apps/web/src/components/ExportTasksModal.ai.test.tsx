import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiGenerateTestsRequest } from '@po/core';
import { ExportTasksModal, assembleAiTestModel, selectForKind } from './ExportTasksModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

/**
 * Развилка «Генерации артефактов» — AI-путь: экран настройки (модель, чекбокс
 * негативов для смок), живой журнал, анти-галлюцинационные счётчики и сборка
 * файла с шаблонным fallback'ом для пропущенных требований.
 */

const getConfig = vi.fn();
const listModels = vi.fn();
const generateTests = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {},
  requirementsApi: {},
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
  implemented: true,
  links: [],
});
const ftB = makeReq({
  slug: 'ft-b',
  name: 'Выход из системы',
  criticality: 'HIGH',
  description: 'Завершение сессии.',
  implemented: true,
  links: [],
});

const CASE_A = {
  slug: 'ft-a',
  title: 'Вход с валидными данными',
  goal: 'Проверить вход',
  precondition: 'Пользователь зарегистрирован',
  steps: ['Открыть форму входа', 'Ввести email и пароль', 'Нажать «Войти»'],
  expected: 'Открыт главный экран',
};

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({
    baseURL: 'https://hub.test/v1',
    hasApiKey: true,
    model: 'DeepSeek-V4-Flash',
  });
  listModels.mockResolvedValue({ models: ['DeepSeek-V4-Flash', 'GigaChat-2-Max'] });
});

async function openAiScreen(
  user: ReturnType<typeof userEvent.setup>,
  dir = 'smoke',
): Promise<void> {
  await user.click(screen.getByTestId(`export-tasks-dir-${dir}`));
  await user.click(await screen.findByTestId('export-mode-ai'));
  await screen.findByTestId('gen-ai');
}

describe('ExportTasksModal · AI-путь развилки', () => {
  it('шаг «Способ» предлагает обе развилки; AI-экран показывает модель проекта и чекбокс негативов (смок)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    expect(await screen.findByTestId('export-mode-template')).toBeInTheDocument();
    expect(screen.getByTestId('export-mode-ai')).toBeInTheDocument();

    await user.click(screen.getByTestId('export-mode-ai'));
    await screen.findByTestId('gen-ai');
    await waitFor(() =>
      expect(screen.getByTestId('gen-ai-model-select')).toHaveValue('DeepSeek-V4-Flash'),
    );
    expect(screen.getByTestId('gen-ai-negatives')).not.toBeChecked();
  });

  it('happy-path: батчи, журнал, счётчики галлюцинаций и автопереход в предпросмотр', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 1, missing: ['ft-b'] });
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );
    await openAiScreen(user);
    await waitFor(() => expect(screen.getByTestId('gen-ai-start')).toBeEnabled());
    await user.click(screen.getByTestId('gen-ai-start'));

    const preview = await screen.findByTestId('export-tasks-preview');
    // Запрос ушёл с видом, слагами отбора и моделью.
    expect(generateTests).toHaveBeenCalledTimes(1);
    const body = generateTests.mock.calls[0]![0] as AiGenerateTestsRequest;
    expect(body).toMatchObject({
      projectId: 'proj-1',
      kind: 'smoke',
      model: 'DeepSeek-V4-Flash',
      negatives: false,
    });
    expect([...body.slugs].sort()).toEqual(['ft-a', 'ft-b']);

    // Файл: AI-кейс + шаблонный fallback для пропущенного, честная шапка.
    expect(preview).toHaveTextContent('Кейсов от модели: 1');
    expect(preview).toHaveTextContent('достроено шаблоном: 1');
    expect(preview).toHaveTextContent('отброшено ответов с несуществующей привязкой: 1');
    expect(preview).toHaveTextContent('Вход с валидными данными');
    expect(preview).toHaveTextContent('source: template-fallback');
    // Заголовок предпросмотра помечен как AI-прогон.
    expect(screen.getByText('Smoke-модель тестирования · AI')).toBeInTheDocument();
  });

  it('журнал прогона: строки о батче и предупреждение о пропусках; «Назад» из предпросмотра сохраняет журнал', async () => {
    const user = userEvent.setup();
    generateTests.mockResolvedValue({ cases: [CASE_A], dropped: 0, missing: ['ft-b'] });
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );
    await openAiScreen(user);
    await waitFor(() => expect(screen.getByTestId('gen-ai-start')).toBeEnabled());
    await user.click(screen.getByTestId('gen-ai-start'));
    await screen.findByTestId('export-tasks-preview');

    await user.click(screen.getByTestId('gen-back-2'));
    const log = await screen.findByTestId('gen-ai-log');
    expect(log).toHaveTextContent('требований 2, батчей 1');
    expect(log).toHaveTextContent('Батч 1/1');
    expect(log).toHaveTextContent('без кейса (достроим шаблоном): «Выход из системы»');
    expect(log).toHaveTextContent('Готово: AI-кейсов 1, достроено шаблоном 1');
  });

  it('ошибка батча: error-строка в журнале, предпросмотр не открыт, можно повторить', async () => {
    const user = userEvent.setup();
    generateTests.mockRejectedValue(new Error('AI Hub недоступен (502)'));
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA]} onClose={vi.fn()} />,
    );
    await openAiScreen(user);
    await waitFor(() => expect(screen.getByTestId('gen-ai-start')).toBeEnabled());
    await user.click(screen.getByTestId('gen-ai-start'));

    const log = await screen.findByTestId('gen-ai-log');
    await waitFor(() => expect(log).toHaveTextContent('AI Hub недоступен (502)'));
    expect(log).toHaveTextContent('генерация остановлена, можно повторить');
    expect(screen.queryByTestId('export-tasks-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('gen-ai-start')).toBeEnabled();
  });

  it('AI не настроен: понятная заглушка вместо формы генерации', async () => {
    const user = userEvent.setup();
    getConfig.mockResolvedValue({ baseURL: 'https://hub.test/v1', hasApiKey: false });
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA]} onClose={vi.fn()} />,
    );
    await openAiScreen(user);
    expect(await screen.findByTestId('gen-ai-not-configured')).toBeInTheDocument();
    expect(screen.queryByTestId('gen-ai-start')).not.toBeInTheDocument();
  });

  it('крит-регресс: вопрос о нереализованных ФТ задаётся и на AI-пути', async () => {
    const user = userEvent.setup();
    const unimpl = makeReq({
      slug: 'ft-plan',
      name: 'Плановое ФТ',
      criticality: 'CRITICAL',
      implemented: false,
      links: [],
    });
    generateTests.mockResolvedValue({ cases: [], dropped: 0, missing: [] });
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, unimpl]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    await user.click(await screen.findByTestId('export-mode-ai'));
    // Сначала вопрос T-532, затем AI-экран.
    expect(await screen.findByTestId('unimpl-question')).toBeInTheDocument();
    await user.click(screen.getByTestId('unimpl-include-no'));
    expect(await screen.findByTestId('gen-ai')).toBeInTheDocument();
    // Чекбокс негативов — только для смок; у крит-регресса негатив всегда.
    expect(screen.queryByTestId('gen-ai-negatives')).not.toBeInTheDocument();
  });
});

describe('assembleAiTestModel / selectForKind (unit)', () => {
  it('отбор единый для обоих путей: смок берёт BLOCKER/CRITICAL/HIGH + корни + нереализованные', () => {
    const low = makeReq({
      slug: 'low-child',
      name: 'Низкая дочка',
      criticality: 'LOW',
      links: [{ type: 'CHILD_OF', targetSlug: 'ft-a' }],
    });
    const smoke = selectForKind('smoke', [ftA, ftB, low]);
    expect(smoke.map((r) => r.slug)).toEqual(['ft-a', 'ft-b']);
  });

  it('сборка: AI-кейс с негативом + fallback с описанием требования; parent-tc для полной модели', () => {
    const parent = makeReq({
      slug: 'p1',
      name: 'Родитель',
      criticality: 'HIGH',
      links: [{ type: 'PARENT_OF', targetSlug: 'c1' }],
    });
    const child = makeReq({
      slug: 'c1',
      name: 'Дочка',
      criticality: 'MEDIUM',
      description: 'Описание дочки',
      links: [{ type: 'CHILD_OF', targetSlug: 'p1' }],
    });
    const md = assembleAiTestModel(
      'full',
      [parent, child],
      new Map([
        [
          'p1',
          {
            ...CASE_A,
            slug: 'p1',
            negativeSteps: ['Ввести неверный пароль'],
            negativeExpected: 'Показана ошибка',
          },
        ],
      ]),
      { model: 'M', aiCases: 1, fallbackCases: 1, dropped: 2 },
    );
    expect(md).toContain('tc-id: FUL-001');
    expect(md).toContain('source: ai');
    expect(md).toContain('**Негативный сценарий:**');
    expect(md).toContain('Показана ошибка');
    // fallback ребёнка: parent-tc указывает на кейс родителя, описание процитировано.
    expect(md).toContain('parent-tc: FUL-001');
    expect(md).toContain('source: template-fallback');
    expect(md).toContain('> Описание дочки');
    expect(md).toContain('отброшено ответов с несуществующей привязкой: 2');
  });
});
