import { describe, it, expect } from 'vitest';
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFocusTrap } from './useFocusTrap';

function Trap({ onClose }: { onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, { initialFocus: cancelRef });
  return (
    <div ref={ref} data-testid="trap">
      <button ref={cancelRef} type="button" data-testid="first" onClick={onClose}>
        Отмена
      </button>
      <button type="button" data-testid="middle">
        Середина
      </button>
      <button type="button" data-testid="last">
        Конец
      </button>
    </div>
  );
}

function Harness(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Открыть
      </button>
      {open ? <Trap onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

describe('useFocusTrap (UX-5)', () => {
  it('moves focus to the initialFocus element on mount', () => {
    render(<Trap onClose={() => {}} />);
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('cycles Tab from the last element back to the first', async () => {
    const user = userEvent.setup();
    render(<Trap onClose={() => {}} />);
    screen.getByTestId('last').focus();
    await user.tab();
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('cycles Shift+Tab from the first element to the last', async () => {
    const user = userEvent.setup();
    render(<Trap onClose={() => {}} />);
    screen.getByTestId('first').focus();
    await user.tab({ shift: true });
    expect(screen.getByTestId('last')).toHaveFocus();
  });

  it('returns focus to the trigger when the trap unmounts', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('first')).toHaveFocus();
    await user.click(screen.getByTestId('first')); // closes the trap
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });

  it('with nested traps, only the TOP-MOST trap cycles Tab (ConfirmDialog over Modal)', async () => {
    function InnerTrap(): React.ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref} data-testid="inner-trap">
          <button type="button" data-testid="inner-first">
            Внутр. 1
          </button>
          <button type="button" data-testid="inner-last">
            Внутр. 2
          </button>
        </div>
      );
    }
    function NestedHarness(): React.ReactElement {
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <div>
          <Trap onClose={() => {}} />
          {innerOpen ? <InnerTrap /> : null}
          <button type="button" data-testid="close-inner" onClick={() => setInnerOpen(false)}>
            Закрыть внутренний
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(<NestedHarness />);

    // Inner (top-most) trap owns the Tab cycle: last → first stays inside it.
    screen.getByTestId('inner-last').focus();
    await user.tab();
    expect(screen.getByTestId('inner-first')).toHaveFocus();

    // Close the inner trap — the outer one takes over the cycle again.
    await user.click(screen.getByTestId('close-inner'));
    screen.getByTestId('last').focus();
    await user.tab();
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  // ── Task 12 · F-2.3: boundary branches ─────────────────────────────────────
  describe('boundary branches', () => {
    function SingleButtonTrap(): React.ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref} data-testid="single-trap">
          <button type="button" data-testid="only">
            Единственная
          </button>
        </div>
      );
    }

    it('Tab on the single focusable element keeps focus on it (first === last)', async () => {
      const user = userEvent.setup();
      render(<SingleButtonTrap />);
      expect(screen.getByTestId('only')).toHaveFocus();
      await user.tab();
      expect(screen.getByTestId('only')).toHaveFocus();
      await user.tab({ shift: true });
      expect(screen.getByTestId('only')).toHaveFocus();
    });

    function EmptyTrap(): React.ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return <div ref={ref} data-testid="empty-trap" />;
    }

    it('a container with no focusable elements swallows Tab (preventDefault)', () => {
      render(<EmptyTrap />);
      // fireEvent returns false when preventDefault() was called.
      expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
      expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    });

    it('ignores non-Tab keys entirely', () => {
      render(<SingleButtonTrap />);
      expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    });

    it('pulls focus back in when the active element escaped the trap (both directions)', () => {
      render(
        <div>
          <SingleButtonTrap />
          <button type="button" data-testid="outside">
            Снаружи
          </button>
        </div>,
      );

      // Focus escaped (e.g. programmatically) → Tab lands on the first element.
      screen.getByTestId('outside').focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(screen.getByTestId('only')).toHaveFocus();

      // Same for Shift+Tab → the last element.
      screen.getByTestId('outside').focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(screen.getByTestId('only')).toHaveFocus();
    });

    function ReturnFocusOffHarness(): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-testid="rf-trigger" onClick={() => setOpen(true)}>
            Открыть
          </button>
          {open ? <NoReturnTrap onClose={() => setOpen(false)} /> : null}
        </div>
      );
    }

    function NoReturnTrap({ onClose }: { onClose: () => void }): React.ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, { returnFocus: false });
      return (
        <div ref={ref}>
          <button type="button" data-testid="rf-inner" onClick={onClose}>
            Закрыть
          </button>
        </div>
      );
    }

    it('returnFocus: false leaves focus where it is on unmount', async () => {
      const user = userEvent.setup();
      render(<ReturnFocusOffHarness />);
      await user.click(screen.getByTestId('rf-trigger'));
      expect(screen.getByTestId('rf-inner')).toHaveFocus();
      await user.click(screen.getByTestId('rf-inner'));
      expect(screen.getByTestId('rf-trigger')).not.toHaveFocus();
    });

    function RestoreToHarness(): React.ReactElement {
      const [open, setOpen] = useState(true);
      const restoreRef = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={restoreRef} type="button" data-testid="restore-target">
            Опенер
          </button>
          {open ? <RestoreTrap restoreTo={restoreRef} onClose={() => setOpen(false)} /> : null}
        </div>
      );
    }

    function RestoreTrap({
      restoreTo,
      onClose,
    }: {
      restoreTo: React.RefObject<HTMLElement | null>;
      onClose: () => void;
    }): React.ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, { restoreTo });
      return (
        <div ref={ref}>
          <button type="button" data-testid="restore-inner" onClick={onClose}>
            Закрыть
          </button>
        </div>
      );
    }

    it('restoreTo: focus returns to the explicitly captured opener on unmount', async () => {
      const user = userEvent.setup();
      render(<RestoreToHarness />);
      expect(screen.getByTestId('restore-inner')).toHaveFocus();
      await user.click(screen.getByTestId('restore-inner'));
      expect(screen.getByTestId('restore-target')).toHaveFocus();
    });
  });
});
