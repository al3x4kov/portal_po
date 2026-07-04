import { describe, it, expect } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
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
});
