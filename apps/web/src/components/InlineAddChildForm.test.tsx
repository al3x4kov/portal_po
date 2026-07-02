import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineAddChildForm } from './InlineAddChildForm';

describe('InlineAddChildForm', () => {
  const defaultProps = {
    parentSlug: 'parent-req',
    depth: 1,
    onSave: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders input and focuses on mount', () => {
    render(<InlineAddChildForm {...defaultProps} />);
    const input = screen.getByTestId('inline-add-child-input');
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  test('Save button disabled when input empty', () => {
    render(<InlineAddChildForm {...defaultProps} />);
    expect(screen.getByTestId('inline-add-child-save')).toBeDisabled();
  });

  test('Save button enabled when name entered', async () => {
    const user = userEvent.setup();
    render(<InlineAddChildForm {...defaultProps} />);
    await user.type(screen.getByTestId('inline-add-child-input'), 'New child');
    expect(screen.getByTestId('inline-add-child-save')).not.toBeDisabled();
  });

  test('calls onSave with trimmed name on submit', async () => {
    const user = userEvent.setup();
    render(<InlineAddChildForm {...defaultProps} />);
    await user.type(screen.getByTestId('inline-add-child-input'), '  Название  ');
    await user.click(screen.getByTestId('inline-add-child-save'));
    await waitFor(() => expect(defaultProps.onSave).toHaveBeenCalledWith('Название'));
  });

  test('calls onCancel on Escape', async () => {
    const user = userEvent.setup();
    render(<InlineAddChildForm {...defaultProps} />);
    await user.type(screen.getByTestId('inline-add-child-input'), 'x');
    await user.keyboard('{Escape}');
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  test('calls onCancel on cancel button click', async () => {
    render(<InlineAddChildForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('inline-add-child-cancel'));
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  test('shows error message when onSave rejects', async () => {
    const user = userEvent.setup();
    const failProps = {
      ...defaultProps,
      onSave: vi.fn().mockRejectedValue(new Error('Уже существует')),
    };
    render(<InlineAddChildForm {...failProps} />);
    await user.type(screen.getByTestId('inline-add-child-input'), 'Дублирующееся');
    await user.click(screen.getByTestId('inline-add-child-save'));
    expect(await screen.findByText('Уже существует')).toBeInTheDocument();
  });

  test('uses correct indent for depth=2', () => {
    render(<InlineAddChildForm {...defaultProps} depth={2} />);
    const form = screen.getByTestId('inline-add-child-form').querySelector('form')!;
    expect(form.style.paddingLeft).toBe('48px'); // 2 * 20 + 8
  });
});
