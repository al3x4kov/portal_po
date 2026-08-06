import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Main } from './Main';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';
import { makeReq } from '../test/fixtures';

const listRequirements = vi.fn();
const moveRequirement = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: vi.fn().mockResolvedValue({
      id: 'proj-1',
      name: 'twitter',
      mainPath: '/Projects/twitter',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    export: vi.fn(),
    exportXlsx: vi.fn(),
    exportSelected: vi.fn(),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn().mockResolvedValue({ available: true, slug: 'x' }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: (...a: unknown[]) => moveRequirement(...a),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({ baseURL: 'https://ai', hasApiKey: true, model: 'M' }),
    listModels: vi.fn().mockResolvedValue({ models: ['M'] }),
  },
  aiImportApi: { start: vi.fn(), getJob: vi.fn(), cancel: vi.fn() },
  dictionariesApi: { get: vi.fn().mockResolvedValue({ priorities: [], sources: [] }) },
}));

/**
 * Лента → Алгоритмическая, Бесконечная прокрутка
 * Личные сообщения → Диалоги 1-на-1
 * Модерация
 */
const requirements = [
  makeReq({
    slug: 'feed',
    name: 'Лента',
    links: [
      { type: 'PARENT_OF', targetSlug: 'algo' },
      { type: 'PARENT_OF', targetSlug: 'infinite' },
    ],
  }),
  makeReq({
    slug: 'algo',
    name: 'Алгоритмическая лента',
    links: [{ type: 'CHILD_OF', targetSlug: 'feed' }],
  }),
  makeReq({
    slug: 'infinite',
    name: 'Бесконечная прокрутка',
    links: [{ type: 'CHILD_OF', targetSlug: 'feed' }],
  }),
  makeReq({
    slug: 'dm',
    name: 'Личные сообщения',
    links: [{ type: 'PARENT_OF', targetSlug: 'dialog' }],
  }),
  makeReq({
    slug: 'dialog',
    name: 'Диалоги 1-на-1',
    links: [{ type: 'CHILD_OF', targetSlug: 'dm' }],
  }),
  makeReq({ slug: 'moder', name: 'Модерация' }),
];

function renderMain(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id" element={<Main />} />
    </Routes>,
    { route: '/p/proj-1' },
  );
}

async function enableStructureMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByTestId('tree-row-feed');
  await user.click(screen.getByTestId('toggle-structure-mode'));
  await screen.findByTestId('structure-bar');
}

/** Выбрать строку так, как это доступно пользователю, — кликом по ручке ⠿. */
async function selectRow(user: ReturnType<typeof userEvent.setup>, slug: string): Promise<void> {
  await user.click(within(screen.getByTestId(`tree-row-${slug}`)).getByTestId('move-grip'));
}

function resetState(): void {
  listRequirements.mockReset();
  listRequirements.mockResolvedValue({ requirements, broken: [] });
  moveRequirement.mockReset();
  moveRequirement.mockResolvedValue({
    childSlug: 'infinite',
    oldParentSlug: 'feed',
    newParentSlug: 'dm',
    movedDescendants: 0,
    changed: true,
  });
  useUiStore.setState({
    treeMode: 'expand-all',
    search: '',
    criticalityFilter: new Set(),
    implementationFilter: new Set(),
    sourceFilter: new Set(),
    aiPendingFilter: false,
    expanded: new Set(),
    collapsedOverrides: new Set(),
    modal: null,
    structureMode: false,
    moveSelection: null,
  });
}

/**
 * Режим структуры — то, чего макеты не обещали.
 *
 * Проверяется не «работает ли счастливый путь» (это уже покрыто), а поведение
 * на границах: перехват клавиатуры, повторные нажатия быстрее ответа сервера,
 * отмена отмены и исчезнувшая из-под ног строка.
 */
describe('Режим структуры · клавиатура не должна отбирать управление', () => {
  beforeEach(resetState);

  it('Tab с кнопки панели уводит фокус, а не двигает строку', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await selectRow(user, 'infinite');

    // Фокус на кнопке выхода: пользователь ушёл с дерева и хочет идти дальше по
    // интерфейсу. Tab здесь — навигация, а не операция над строкой.
    const exit = screen.getByTestId('structure-exit');
    exit.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    exit.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false);
  });

  it('Esc упомянут в панели — иначе выход из перехвата клавиатуры не найти', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await selectRow(user, 'infinite');

    const bar = screen.getByTestId('structure-bar');
    expect(bar.textContent).toMatch(/Esc/i);
  });
});

describe('Режим структуры · повторные нажатия быстрее ответа сервера', () => {
  beforeEach(resetState);

  it('второе нажатие во время незавершённого перемещения не шлёт второй запрос', async () => {
    // Сервер «думает»: ответ не приходит, пока пользователь жмёт ещё раз.
    let release: (v: unknown) => void = () => {};
    moveRequirement.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await selectRow(user, 'algo');

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(moveRequirement).toHaveBeenCalledTimes(1);
    release({
      childSlug: 'algo',
      oldParentSlug: 'feed',
      newParentSlug: 'dm',
      movedDescendants: 0,
      changed: true,
    });
  });
});

describe('Режим структуры · отмена', () => {
  beforeEach(resetState);

  it('повторный Ctrl+Z не возвращает строку обратно (отмена — не качели)', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await selectRow(user, 'infinite');

    // Переезд «Бесконечной прокрутки» под «Личные сообщения».
    moveRequirement.mockResolvedValue({
      childSlug: 'infinite',
      oldParentSlug: 'feed',
      newParentSlug: 'dm',
      movedDescendants: 0,
      changed: true,
    });
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(moveRequirement).toHaveBeenCalledTimes(1));

    // Отмена: сервер сообщает, что строка вернулась под «Ленту».
    moveRequirement.mockResolvedValue({
      childSlug: 'infinite',
      oldParentSlug: 'dm',
      newParentSlug: 'feed',
      movedDescendants: 0,
      changed: true,
    });
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(moveRequirement).toHaveBeenCalledTimes(2));

    // Второй Ctrl+Z: отменять больше нечего.
    await user.keyboard('{Control>}z{/Control}');
    await new Promise((r) => setTimeout(r, 50));
    expect(moveRequirement).toHaveBeenCalledTimes(2);
  });
});

describe('Режим структуры · текст конфликта', () => {
  beforeEach(resetState);

  it('конфликт объясняется по-русски именами, а не слагами из ответа сервера', async () => {
    const { ApiError } = await import('../api/client');
    moveRequirement.mockRejectedValue(
      new ApiError(409, {
        code: 'STALE_PARENT',
        message:
          'Requirement "infinite" now hangs under "dm", not "feed"; refresh the tree and repeat the move.',
        details: { actualParentSlug: 'dm' },
      }),
    );
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await selectRow(user, 'infinite');

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    const bar = await screen.findByTestId('structure-bar');
    await waitFor(() => expect(bar.textContent).toMatch(/не сохранено/));
    // Имя требования и имя нового родителя — те же, что человек видит в дереве.
    expect(bar.textContent).toContain('Бесконечная прокрутка');
    expect(bar.textContent).toContain('Личные сообщения');
    // Технический английский наружу не протекает.
    expect(bar.textContent).not.toMatch(/now hangs under|refresh the tree/);
  });
});

describe('Режим структуры · свёрнутое дерево показывает не все строки', () => {
  beforeEach(resetState);

  it('в свёрнутом дереве режим недоступен так же, как при фильтре', async () => {
    // Фильтр гасит режим, потому что «дерево показано не целиком». Свёрнутое
    // дерево скрывает ровно так же: видны только корни, а потомки уезжают
    // вслепую.
    useUiStore.setState({ treeMode: 'collapse' });
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-feed');

    const toggle = screen.getByTestId('toggle-structure-mode');
    expect(toggle.getAttribute('data-disabled')).toBe('true');

    await user.click(toggle);
    expect(screen.queryByTestId('structure-bar')).toBeNull();
  });
});

describe('Режим структуры · строка исчезла из-под ног', () => {
  beforeEach(resetState);

  it('выбор пропавшей строки не оставляет панель с фантомными операциями', async () => {
    // Строку удалили в другом окне: выбор в состоянии остался, в данных её нет.
    useUiStore.setState({ structureMode: true, moveSelection: 'удалённая-строка' });
    renderMain();
    await screen.findByTestId('tree-row-feed');
    await screen.findByTestId('structure-bar');

    // Панель не должна предлагать операции над тем, чего нет.
    expect(screen.queryByTestId('structure-ops')).toBeNull();
    expect(screen.getByTestId('structure-hint')).toBeInTheDocument();
  });
});
