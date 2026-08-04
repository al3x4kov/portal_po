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

describe('Modal size variant (task24)', () => {
  it('default size keeps the old classes (no 70vw/70vh, space-y body)', () => {
    renderWithProviders(
      <Modal title="Обычная" onClose={vi.fn()} testid="modal">
        <p>content</p>
      </Modal>,
    );
    const card = screen.getByTestId('modal');
    expect(card.className).toContain('max-h-[90vh]');
    expect(card.className).toContain('max-w-xl');
    expect(card.className).not.toContain('md:w-[70vw]');
    expect(card.className).not.toContain('md:h-[max(70vh,min(640px,80vh))]');
    const body = screen.getByTestId('modal-body');
    expect(body.className).toContain('space-y-5');
    expect(body.className).not.toContain('flex-col');
  });

  it('size="large" takes ~70% of the viewport on desktop and makes the body a flex column', () => {
    renderWithProviders(
      <Modal title="Большая" onClose={vi.fn()} testid="modal" size="large">
        <p>content</p>
      </Modal>,
    );
    const card = screen.getByTestId('modal');
    // Desktop (md+): ~70% of the viewport in both dimensions, capped at 80vh;
    // on short screens the height rises towards min(600px, 80vh) so the log
    // gets real extra room (QA defect on 1280×800).
    expect(card.className).toContain('md:w-[70vw]');
    expect(card.className).toContain('md:max-w-[70vw]');
    expect(card.className).toContain('md:h-[max(70vh,min(640px,80vh))]');
    expect(card.className).toContain('md:max-h-[80vh]');
    // Mobile stays as before: full width + 90vh cap (no md: prefix on these).
    expect(card.className).toContain('w-full');
    expect(card.className).toContain('max-h-[90vh]');
    // The body is a flex column so a flex-1 child can absorb the free height.
    const body = screen.getByTestId('modal-body');
    expect(body.className).toContain('flex-col');
    expect(body.className).toContain('gap-5');
  });

  it('size="xl" takes ~90% of the viewport on desktop and keeps the flex-column body', () => {
    renderWithProviders(
      <Modal title="Огромная" onClose={vi.fn()} testid="modal" size="xl">
        <p>content</p>
      </Modal>,
    );
    const card = screen.getByTestId('modal');
    // Desktop (md+): ~90% of the viewport — a table-driven step (backlog review
    // gate) showed only ~3 rows inside the 70vh `large` card.
    expect(card.className).toContain('md:w-[92vw]');
    expect(card.className).toContain('md:max-w-[92vw]');
    expect(card.className).toContain('md:h-[90vh]');
    expect(card.className).toContain('md:max-h-[90vh]');
    // Not the `large` geometry.
    expect(card.className).not.toContain('md:w-[70vw]');
    // Mobile stays as before: full width + 90vh cap (no md: prefix on these).
    expect(card.className).toContain('w-full');
    expect(card.className).toContain('max-h-[90vh]');
    // Same flex column as `large`, so a flex-1 child absorbs the free height.
    const body = screen.getByTestId('modal-body');
    expect(body.className).toContain('flex-col');
    expect(body.className).toContain('gap-5');
    expect(body.className).toContain('min-h-0');
  });
});
