import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  makeReq({ slug: 'uptime', type: 'NFR', name: 'Доступность 99.95%' }),
];

function renderMain(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id" element={<Main />} />
    </Routes>,
    { route: '/p/proj-1' },
  );
}

/** Включить режим структуры так, как это делает пользователь — тумблером. */
async function enableStructureMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByTestId('tree-row-feed');
  await user.click(screen.getByTestId('toggle-structure-mode'));
  await screen.findByTestId('structure-bar');
}

/** Перетащить строку `from` на строку `to` (HTML5 drag&drop). */
function dragRowOnto(fromSlug: string, toSlug: string): void {
  const grip = screen
    .getByTestId(`tree-row-${fromSlug}`)
    .querySelector('[data-testid="move-grip"]') as HTMLElement;
  fireEvent.dragStart(grip);
  const target = screen.getByTestId(`tree-row-${toSlug}`);
  fireEvent.dragOver(target);
  fireEvent.drop(target);
}

describe('Режим структуры · П1 базовый режим', () => {
  beforeEach(() => {
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
  });

  it('в обычном режиме ручек перемещения нет — случайно не перетащишь', async () => {
    renderMain();
    await screen.findByTestId('tree-row-feed');
    expect(screen.queryAllByTestId('move-grip')).toHaveLength(0);
    expect(screen.getByTestId('main-footer')).toBeInTheDocument();
  });

  it('тумблер включает режим: появляются ручки и панель перемещения', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    expect(screen.getAllByTestId('move-grip').length).toBeGreaterThan(0);
    // Панель действий на время режима уступает место панели перемещения.
    expect(screen.queryByTestId('main-footer')).not.toBeInTheDocument();
  });

  it('выбор строки показывает текущего родителя, уровень и число потомков', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await user.click(within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip'));

    expect(screen.getByTestId('structure-current-parent')).toHaveTextContent('Лента');
    expect(screen.getByTestId('structure-bar')).toHaveTextContent('уровень 2 из 2');
    expect(screen.getByTestId('structure-bar')).toHaveTextContent('потомков переедет: 0');
    expect(screen.getByTestId('structure-bar')).toHaveTextContent('1 связь CHILD_OF');
  });

  it('стрелки занимают ту же зону, что иконки действий — колонки не пропадают', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await user.click(within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip'));

    // У выбранной строки — стрелки; у остальных зона осталась обычной.
    expect(screen.getByTestId('move-ops-infinite')).toBeInTheDocument();
    expect(screen.getByTestId('row-actions-feed')).toBeInTheDocument();
    // Все колонки на месте.
    const row = screen.getByTestId('tree-row-infinite');
    expect(within(row).getByTestId('req-criticality-cell')).toBeInTheDocument();
    expect(within(row).getByTestId('req-rice-cell')).toBeInTheDocument();
    expect(within(row).getByTestId('req-sources-cell')).toBeInTheDocument();
    expect(within(row).getByTestId('req-term-cell')).toBeInTheDocument();
    expect(within(row).getByTestId('req-links-cell')).toBeInTheDocument();
  });
});

describe('Режим структуры · П2 перетаскивание', () => {
  beforeEach(() => {
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
    useUiStore.setState({ structureMode: false, moveSelection: null, search: '' });
  });

  it('бросок на строку делает её новым родителем', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');

    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'infinite', {
        parentSlug: 'dm',
        expectedParentSlug: 'feed',
      }),
    );
  });

  it('цель подсвечена как разрешённая, исходная строка помечена как перетаскиваемая', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    const grip = within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip');
    fireEvent.dragStart(grip);

    expect(screen.getByTestId('tree-row-dm')).toHaveAttribute('data-drop-state', 'allow');
    expect(screen.getByTestId('tree-row-infinite')).not.toHaveAttribute('data-drop-state', 'allow');
  });

  it('бросок в пустое поле выносит строку в корень раздела', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    const grip = within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip');
    fireEvent.dragStart(grip);
    const zone = screen.getByTestId('drop-to-root-function');
    fireEvent.dragOver(zone);
    fireEvent.drop(zone);

    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'infinite', {
        parentSlug: null,
        expectedParentSlug: 'feed',
      }),
    );
  });
});

describe('Режим структуры · П4 запреты', () => {
  beforeEach(() => {
    listRequirements.mockReset();
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    moveRequirement.mockReset();
    useUiStore.setState({ structureMode: false, moveSelection: null, search: '' });
  });

  it('цель-потомок краснеет и бросок не уходит на сервер (цикл)', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    const grip = within(screen.getByTestId('tree-row-feed')).getByTestId('move-grip');
    fireEvent.dragStart(grip);
    const target = screen.getByTestId('tree-row-algo');

    expect(target).toHaveAttribute('data-drop-state', 'deny');
    expect(target).toHaveAttribute('title', expect.stringContaining('потомка'));

    fireEvent.drop(target);
    expect(moveRequirement).not.toHaveBeenCalled();
  });

  it('ФТ нельзя бросить на НФТ — иерархия только внутри типа', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    const grip = within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip');
    fireEvent.dragStart(grip);
    const target = screen.getByTestId('tree-row-uptime');

    expect(target).toHaveAttribute('data-drop-state', 'deny');
    fireEvent.drop(target);
    expect(moveRequirement).not.toHaveBeenCalled();
  });

  it('недоступная стрелка не исчезает и называет причину', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await user.click(within(screen.getByTestId('tree-row-feed')).getByTestId('move-grip'));

    const outdent = within(screen.getByTestId('move-ops-feed')).getByTestId('move-op-outdent');
    expect(outdent).toHaveAttribute('data-blocked', 'true');
    expect(outdent).toHaveAttribute('aria-disabled', 'true');
    expect(outdent.getAttribute('aria-label')).toMatch(/корне/i);

    await user.click(outdent);
    expect(moveRequirement).not.toHaveBeenCalled();
  });
});

describe('Режим структуры · П3 клавиатура и стрелки', () => {
  beforeEach(() => {
    listRequirements.mockReset();
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    moveRequirement.mockReset();
    moveRequirement.mockResolvedValue({
      childSlug: 'infinite',
      oldParentSlug: 'feed',
      newParentSlug: 'algo',
      movedDescendants: 0,
      changed: true,
    });
    useUiStore.setState({ structureMode: false, moveSelection: null, search: '' });
  });

  it('стрелка «вложить» отправляет строку под соседа выше', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await user.click(within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip'));

    await user.click(within(screen.getByTestId('move-ops-infinite')).getByTestId('move-op-indent'));

    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'infinite', {
        parentSlug: 'algo',
        expectedParentSlug: 'feed',
      }),
    );
  });

  it('Tab перемещает выбранную строку без мыши', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    const grip = within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip');
    await user.click(grip);

    // Событие приходит на сфокусированную ручку — так же, как в браузере: Tab
    // работает как «вложить» только внутри дерева, а не на кнопках панели.
    fireEvent.keyDown(grip, { key: 'Tab' });

    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'infinite', {
        parentSlug: 'algo',
        expectedParentSlug: 'feed',
      }),
    );
  });

  it('Shift+Tab поднимает строку на уровень выше', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    const grip = within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip');
    await user.click(grip);

    fireEvent.keyDown(grip, { key: 'Tab', shiftKey: true });

    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'infinite', {
        parentSlug: null,
        expectedParentSlug: 'feed',
      }),
    );
  });

  it('Esc снимает выбор строки', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);
    await user.click(within(screen.getByTestId('tree-row-infinite')).getByTestId('move-grip'));
    expect(screen.getByTestId('move-ops-infinite')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('move-ops-infinite')).not.toBeInTheDocument());
  });
});

describe('Режим структуры · П5 поддерево и П6 отмена', () => {
  const bigTree = [
    makeReq({
      slug: 'feed',
      name: 'Лента',
      links: [
        { type: 'PARENT_OF', targetSlug: 'algo' },
        { type: 'PARENT_OF', targetSlug: 'infinite' },
        { type: 'PARENT_OF', targetSlug: 'chrono' },
      ],
    }),
    makeReq({
      slug: 'algo',
      name: 'Алгоритмическая лента',
      links: [
        { type: 'CHILD_OF', targetSlug: 'feed' },
        { type: 'PARENT_OF', targetSlug: 'rank' },
      ],
    }),
    makeReq({
      slug: 'rank',
      name: 'Ранжирование',
      links: [{ type: 'CHILD_OF', targetSlug: 'algo' }],
    }),
    makeReq({
      slug: 'infinite',
      name: 'Бесконечная прокрутка',
      links: [{ type: 'CHILD_OF', targetSlug: 'feed' }],
    }),
    makeReq({
      slug: 'chrono',
      name: 'Хронологическая лента',
      links: [{ type: 'CHILD_OF', targetSlug: 'feed' }],
    }),
    makeReq({ slug: 'dm', name: 'Личные сообщения' }),
  ];

  beforeEach(() => {
    listRequirements.mockReset();
    listRequirements.mockResolvedValue({ requirements: bigTree, broken: [] });
    moveRequirement.mockReset();
    moveRequirement.mockResolvedValue({
      childSlug: 'feed',
      oldParentSlug: null,
      newParentSlug: 'dm',
      movedDescendants: 4,
      changed: true,
    });
    useUiStore.setState({ structureMode: false, moveSelection: null, search: '' });
  });

  it('переезд раздела с четырьмя потомками сначала спрашивает подтверждение', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('feed', 'dm');

    const dialog = await screen.findByTestId('move-subtree-dialog');
    expect(within(dialog).getByTestId('move-subtree-message')).toHaveTextContent(
      /4 требования|4 требований/,
    );
    expect(moveRequirement).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Перенести' }));
    await waitFor(() =>
      expect(moveRequirement).toHaveBeenCalledWith('proj-1', 'feed', {
        parentSlug: 'dm',
        expectedParentSlug: null,
      }),
    );
  });

  it('отмена диалога не двигает раздел', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('feed', 'dm');
    const dialog = await screen.findByTestId('move-subtree-dialog');
    await user.click(within(dialog).getByTestId('move-subtree-dialog-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('move-subtree-dialog')).not.toBeInTheDocument(),
    );
    expect(moveRequirement).not.toHaveBeenCalled();
  });

  it('после перемещения появляется отмена и запись в журнале сеанса', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');
    await waitFor(() => expect(moveRequirement).toHaveBeenCalled());

    const undo = await screen.findByTestId('structure-undo');
    await waitFor(() => expect(undo).not.toBeDisabled());
    expect(screen.getByTestId('structure-history')).toBeInTheDocument();
  });

  it('Ctrl+Z возвращает строку прежнему родителю', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');
    await waitFor(() => expect(moveRequirement).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });

    // Второй вызов — обратное перемещение к родителю, который вернул сервер.
    await waitFor(() => expect(moveRequirement).toHaveBeenCalledTimes(2));
    expect(moveRequirement.mock.calls[1][2]).toMatchObject({ parentSlug: null });
  });
});

describe('Режим структуры · П7 конфликт и обрыв сети', () => {
  beforeEach(() => {
    listRequirements.mockReset();
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    moveRequirement.mockReset();
    useUiStore.setState({ structureMode: false, moveSelection: null, search: '' });
  });

  it('конфликт версий: строка помечена как несохранённая, есть повтор и «оставить как на диске»', async () => {
    const { ApiError } = await import('../api/client');
    moveRequirement.mockRejectedValueOnce(
      new ApiError(409, {
        code: 'STALE_PARENT',
        message: 'Требование уже перевесили.',
        details: { actualParentSlug: 'dm' },
      }),
    );
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');

    const error = await screen.findByTestId('structure-error');
    expect(error).toHaveTextContent(/не сохранено/i);
    expect(screen.getByTestId('tree-row-infinite')).toHaveAttribute('data-drop-state', 'failed');
    expect(screen.getByTestId('structure-retry')).toBeInTheDocument();
    expect(screen.getByTestId('structure-dismiss-error')).toBeInTheDocument();
  });

  it('обрыв сети обрабатывается так же — и повтор уходит на сервер', async () => {
    moveRequirement.mockRejectedValueOnce(new Error('Failed to fetch'));
    moveRequirement.mockResolvedValueOnce({
      childSlug: 'infinite',
      oldParentSlug: 'feed',
      newParentSlug: 'dm',
      movedDescendants: 0,
      changed: true,
    });
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');
    await screen.findByTestId('structure-error');

    await user.click(screen.getByTestId('structure-retry'));
    await waitFor(() => expect(moveRequirement).toHaveBeenCalledTimes(2));
  });

  it('«оставить как на диске» убирает ошибку и подсветку', async () => {
    moveRequirement.mockRejectedValueOnce(new Error('Failed to fetch'));
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    dragRowOnto('infinite', 'dm');
    await screen.findByTestId('structure-error');

    await user.click(screen.getByTestId('structure-dismiss-error'));
    await waitFor(() => expect(screen.queryByTestId('structure-error')).not.toBeInTheDocument());
    expect(screen.getByTestId('tree-row-infinite')).not.toHaveAttribute(
      'data-drop-state',
      'failed',
    );
  });
});

describe('Режим структуры · П8 активен фильтр', () => {
  beforeEach(() => {
    listRequirements.mockReset();
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    moveRequirement.mockReset();
    useUiStore.setState({
      structureMode: false,
      moveSelection: null,
      search: '',
      criticalityFilter: new Set(),
      implementationFilter: new Set(),
      sourceFilter: new Set(),
      aiPendingFilter: false,
    });
  });

  it('при активном фильтре тумблер помечен недоступным и режим не включается', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-feed');
    useUiStore.setState({ criticalityFilter: new Set(['HIGH']) });

    const toggle = await screen.findByTestId('toggle-structure-mode');
    await waitFor(() => expect(toggle).toHaveAttribute('data-disabled', 'true'));

    await user.click(toggle);
    expect(screen.queryByTestId('structure-bar')).not.toBeInTheDocument();
  });

  it('включённый фильтр гасит уже открытый режим структуры', async () => {
    const user = userEvent.setup();
    renderMain();
    await enableStructureMode(user);

    useUiStore.setState({ search: 'лента' });

    await waitFor(() => expect(screen.queryByTestId('structure-bar')).not.toBeInTheDocument());
  });
});
