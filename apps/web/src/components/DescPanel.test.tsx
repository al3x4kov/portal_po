import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DescPanel } from './DescPanel';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const longText = 'A'.repeat(400) + ' конец описания';

describe('DescPanel (T-1104, FR-7.4 / T6 desc-panel mockup §2.7)', () => {
  it('renders the full description without truncation and a breadcrumb', () => {
    const req = makeReq({ slug: 'token', name: 'Токенизация', description: longText });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={['Платежи', 'Оплата картой']}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const panel = screen.getByTestId('desc-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('desc-panel-body')).toHaveTextContent('конец описания');
    const path = screen.getByTestId('desc-panel-path');
    expect(path).toHaveTextContent('Платежи');
    expect(path).toHaveTextContent('Оплата картой');
    expect(path).toHaveTextContent('Токенизация');
  });

  it('renders the description as Markdown WITHOUT raw HTML (safe render)', () => {
    const req = makeReq({
      slug: 'md',
      name: 'Markdown',
      description: '### Сценарий\n\n- пункт списка\n\nКод `GET /api` и <script>alert(1)</script>',
    });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const body = screen.getByTestId('desc-panel-body');
    // Markdown-структуры отрендерены
    expect(body.querySelector('h3')).toHaveTextContent('Сценарий');
    expect(body.querySelector('li')).toHaveTextContent('пункт списка');
    expect(body.querySelector('code')).toHaveTextContent('GET /api');
    // Сырой HTML НЕ вставлен в DOM
    expect(body.querySelector('script')).toBeNull();
  });

  it('shows the empty-description placeholder', () => {
    const req = makeReq({ slug: 'e', name: 'Пустое', description: '' });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('desc-panel-body')).toHaveTextContent('Описание не заполнено.');
  });

  it('clamps the title to 2 lines and expands it on click (line-clamp-2)', async () => {
    const user = userEvent.setup();
    const name = 'Очень длинное имя требования '.repeat(4).trim();
    const req = makeReq({ slug: 'long', name, description: 'x' });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const title = screen.getByTestId('desc-panel-title');
    expect(title).toHaveClass('line-clamp-2');
    expect(title).toHaveAttribute('title', name);
    expect(title).toHaveAttribute('aria-expanded', 'false');

    await user.click(title);
    expect(title).not.toHaveClass('line-clamp-2');
    expect(title).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders link chips with Russian type + target name and a «+N» expander', async () => {
    const user = userEvent.setup();
    const req = makeReq({
      slug: 'search',
      name: 'Поиск',
      description: 'x',
      links: [
        { type: 'PARENT_OF', targetSlug: 'child-1' },
        { type: 'PARENT_OF', targetSlug: 'child-2' },
        { type: 'CHILD_OF', targetSlug: 'catalog' },
        { type: 'DEPENDS_ON', targetSlug: 'index' },
        { type: 'RELATES_TO', targetSlug: 'nfr-speed' },
        { type: 'BLOCKED_BY', targetSlug: 'auth' },
      ],
    });
    const nameBySlug = new Map([
      ['catalog', 'Каталог товаров'],
      ['index', 'Индексация склада'],
      ['nfr-speed', 'Время отклика'],
      ['auth', 'Авторизация'],
    ]);
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        nameBySlug={nameBySlug}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // 5 чипов всего (2 вложенных + 4 связи), видимы первые 3 + «+2»
    expect(screen.getAllByTestId('desc-panel-link-chip')).toHaveLength(3);
    expect(screen.getByText('2 вложенных')).toBeInTheDocument();
    expect(screen.getByText('родитель · Каталог товаров')).toBeInTheDocument();
    expect(screen.getByText('зависит · Индексация склада')).toBeInTheDocument();

    const more = screen.getByTestId('desc-panel-links-more');
    expect(more).toHaveTextContent('+2');
    await user.click(more);
    expect(screen.getAllByTestId('desc-panel-link-chip')).toHaveLength(5);
    expect(screen.getByText('связано · Время отклика')).toBeInTheDocument();
    expect(screen.getByText('блокируется · Авторизация')).toBeInTheDocument();
    expect(screen.queryByTestId('desc-panel-links-more')).not.toBeInTheDocument();
  });

  it('closes on the close button and on Escape (keyboard accessible)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const req = makeReq({ slug: 'r1', name: 'Req', description: 'x' });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={onClose}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('desc-panel-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('UX-10: closes on a scrim click (read-only drawer policy)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const req = makeReq({ slug: 'r1', name: 'Req', description: 'x' });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={onClose}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('desc-panel-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wires edit and delete actions', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    const req = makeReq({ slug: 'r1', name: 'Req', description: 'x' });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={vi.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    await user.click(screen.getByTestId('desc-panel-edit'));
    await user.click(screen.getByTestId('desc-panel-delete'));
    expect(onEdit).toHaveBeenCalledWith(req);
    expect(onDelete).toHaveBeenCalledWith(req);
  });

  it('disables «Удалить» with a visible reason while the requirement has children (§2.7)', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    const req = makeReq({
      slug: 'parent',
      name: 'Родительское',
      description: 'x',
      links: [
        { type: 'PARENT_OF', targetSlug: 'c1' },
        { type: 'PARENT_OF', targetSlug: 'c2' },
      ],
    });
    renderWithProviders(
      <DescPanel
        requirement={req}
        path={[]}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />,
    );
    const del = screen.getByTestId('desc-panel-delete');
    expect(del).toBeDisabled();
    expect(screen.getByTestId('desc-panel-delete-reason')).toHaveTextContent(
      'Удаление недоступно: сначала удалите дочерние (2 вложенных).',
    );
    await user.click(del).catch(() => undefined);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
