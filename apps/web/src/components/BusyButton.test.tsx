import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BusyButton } from './BusyButton';

describe('BusyButton (T1 primitive)', () => {
  it('renders children and fires onClick when idle', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <BusyButton data-testid="save" onClick={onClick}>
        Сохранить
      </BusyButton>,
    );
    const btn = screen.getByTestId('save');
    expect(btn).toHaveTextContent('Сохранить');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(btn.querySelector('.spinner')).toBeNull();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('while busy: disabled, aria-busy, spinner + gerund label', () => {
    render(
      <BusyButton data-testid="save" busy busyLabel="Сохраняем…">
        Сохранить
      </BusyButton>,
    );
    const btn = screen.getByTestId('save');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.spinner')).not.toBeNull();
    expect(btn).toHaveTextContent('Сохраняем…');
    expect(btn).not.toHaveTextContent('Сохранить');
  });

  it('falls back to children when busy without busyLabel', () => {
    render(
      <BusyButton data-testid="save" busy>
        Сохранить
      </BusyButton>,
    );
    const btn = screen.getByTestId('save');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Сохранить');
    expect(btn.querySelector('.spinner')).not.toBeNull();
  });

  it('respects explicit disabled and custom className, defaults type=button', () => {
    render(
      <BusyButton data-testid="del" disabled className="btn btn-danger btn-sm">
        Удалить
      </BusyButton>,
    );
    const btn = screen.getByTestId('del');
    expect(btn).toBeDisabled();
    expect(btn).toHaveClass('btn', 'btn-danger', 'btn-sm');
    expect(btn).toHaveAttribute('type', 'button');
  });
});
