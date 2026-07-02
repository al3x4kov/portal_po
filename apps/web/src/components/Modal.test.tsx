import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';
import { renderWithProviders } from '../test/utils';

describe('Modal scrim policy (UX-10)', () => {
  it('does NOT close a form modal on a backdrop click (protects typed data)', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Modal title="Форма" onClose={onClose} testid="modal">
        <input aria-label="field" />
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and on the explicit close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <Modal title="Форма" onClose={onClose} testid="modal">
        <input aria-label="field" />
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('modal-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
