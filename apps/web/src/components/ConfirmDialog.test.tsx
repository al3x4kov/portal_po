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

  it('renders a default trash icon (Lucide, no emoji) for danger dialogs when `icon` is not given', () => {
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
    const icon = screen.getByTestId('delete-dialog-icon');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon).not.toHaveTextContent('🗑');
  });

  it('renders a custom icon instead of the default when `icon` is provided (Task 11 follow-up)', () => {
    render(
      <ConfirmDialog
        testid="stop-dialog"
        danger
        icon="⏹"
        title="Прекратить автоматизацию?"
        message="Анализ будет остановлен."
        confirmLabel="Остановить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const icon = screen.getByTestId('stop-dialog-icon');
    expect(icon).toHaveTextContent('⏹');
    expect(icon.querySelector('svg')).toBeNull();
  });

  it('renders no icon at all when `icon` is null', () => {
    render(
      <ConfirmDialog
        testid="stop-dialog"
        danger
        icon={null}
        title="Прекратить автоматизацию?"
        message="Анализ будет остановлен."
        confirmLabel="Остановить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('stop-dialog-icon')).not.toBeInTheDocument();
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

  // ── T4 · уровни трения (confirm-dialog mockup) ─────────────────────────────
  it('busy: confirm button shows spinner + gerund and both buttons are disabled (§2.13-1)', () => {
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        busy
        busyLabel="Удаляем…"
        title="Удалить требование?"
        message="«X» будет удалено."
        confirmLabel="Удалить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirm = screen.getByTestId('delete-dialog-confirm');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent('Удаляем…');
    expect(confirm.querySelector('.spinner')).not.toBeNull();
    expect(screen.getByTestId('delete-dialog-cancel')).toBeDisabled();
  });

  it('confirmDisabledReason: micro-text under the buttons, wired via aria-describedby (§2.13-2)', () => {
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        confirmDisabled
        confirmDisabledReason="Сначала удалите дочерние: «Фильтр по цене»"
        title="Удалить требование?"
        message="«Каталог товаров» содержит вложенные требования."
        confirmLabel="Удалить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const reason = screen.getByTestId('delete-dialog-disabled-reason');
    expect(reason).toHaveTextContent('Сначала удалите дочерние: «Фильтр по цене»');
    const confirm = screen.getByTestId('delete-dialog-confirm');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-describedby', 'delete-dialog-disabled-reason');
  });

  it('level 2 (typeToConfirm): confirm stays disabled until the exact name is typed', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        testid="project-dialog"
        danger
        title="Удалить проект «Портал»?"
        message="Все файлы проекта будут удалены с диска безвозвратно."
        confirmLabel="Удалить проект"
        typeToConfirm={{
          expected: 'Портал',
          label: 'Введите имя проекта для подтверждения',
          hint: 'Кнопка активируется при точном совпадении имени',
        }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByTestId('project-dialog-input');
    // Level 2 focuses the guarded input, not Cancel.
    expect(input).toHaveFocus();
    expect(screen.getByText('Кнопка активируется при точном совпадении имени')).toBeInTheDocument();

    const confirm = screen.getByTestId('project-dialog-confirm');
    expect(confirm).toBeDisabled();
    await user.type(input, 'не то имя');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Портал');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('level 2: honours a custom input testid (e2e contract of the project delete dialog)', () => {
    render(
      <ConfirmDialog
        testid="project-delete-dialog"
        danger
        title="Удалить проект «X»?"
        message="Файлы будут удалены."
        confirmLabel="Удалить проект"
        typeToConfirm={{
          expected: 'X',
          label: 'Введите имя проекта для подтверждения',
          inputTestid: 'delete-confirm-input',
        }}
        error="Папка занята другим процессом"
        errorTestid="delete-error"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-confirm-input')).toBeInTheDocument();
    expect(screen.getByTestId('delete-error')).toHaveTextContent('Папка занята другим процессом');
  });

  it('note supports the success tone («удаление безопасно»)', () => {
    render(
      <ConfirmDialog
        testid="delete-dialog"
        danger
        title="Удалить требование?"
        message="«X» будет удалено."
        note={{ tone: 'success', text: 'Вложенных требований нет — удаление безопасно.' }}
        confirmLabel="Удалить"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-dialog-note')).toHaveTextContent('удаление безопасно');
  });
});
