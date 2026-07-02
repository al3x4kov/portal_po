import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog (T-606, FR-9)', () => {
  it('fires confirm / cancel callbacks and renders a destructive note', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        title="Точно удалить требование?"
        message="«X» будет удалено безвозвратно."
        note={{
          tone: 'warning',
          text: 'У требования нет дочерних элементов — удаление безопасно.',
        }}
        confirmLabel="Удалить"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId('delete-dialog-note')).toHaveTextContent('удаление безопасно');
    await user.click(screen.getByTestId('delete-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('delete-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button and blocks the click when confirmDisabled (UX-3)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        confirmDisabled
        title="Точно удалить требование?"
        message="«X» будет удалено."
        note={{ tone: 'danger', text: 'У требования есть дочерние элементы.' }}
        confirmLabel="Удалить"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const confirm = screen.getByTestId('delete-dialog-confirm');
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('focuses the safe Cancel button on open (UX-5)', () => {
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        title="Точно удалить требование?"
        message="«X» будет удалено."
        confirmLabel="Удалить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-dialog-cancel')).toHaveFocus();
  });
});
