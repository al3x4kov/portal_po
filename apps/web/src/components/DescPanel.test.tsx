import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DescPanel } from './DescPanel';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const longText = 'A'.repeat(400) + ' конец описания';

describe('DescPanel (T-1104, FR-7.4)', () => {
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
    expect(screen.getByTestId('desc-panel-path')).toHaveTextContent('Платежи / Оплата картой');
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
});
