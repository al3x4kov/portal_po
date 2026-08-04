import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Requirement } from '@po/core';
import { RequirementModal } from './RequirementModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const checkName = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock('../api/endpoints', () => ({
  requirementsApi: {
    checkName: (...a: unknown[]) => checkName(...a),
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    list: vi.fn(),
    remove: vi.fn(),
  },
  projectsApi: {},
  linksApi: { create: vi.fn(), remove: vi.fn() },
  dictionariesApi: {
    get: vi.fn().mockResolvedValue({
      priorities: [{ id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 }],
      sources: [],
    }),
    addPriority: vi.fn(),
    updatePriority: vi.fn(),
    deletePriority: vi.fn(),
    addSource: vi.fn(),
    updateSource: vi.fn(),
    deleteSource: vi.fn(),
  },
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({ baseURL: '', hasApiKey: false }),
    saveConfig: vi.fn(),
    listModels: vi.fn(),
    generateDescription: vi.fn(),
  },
}));

function renderModal(requirement: Requirement): void {
  renderWithProviders(
    <RequirementModal
      projectId="p1"
      reqType="FUNCTION"
      requirement={requirement}
      onClose={vi.fn()}
    />,
  );
}

describe('RequirementModal — блок «Проверка» (task26)', () => {
  beforeEach(() => {
    checkName.mockReset();
    create.mockReset();
    update.mockReset();
    checkName.mockResolvedValue({ available: true, slug: 'ai-1' });
    update.mockResolvedValue({});
  });

  it('у требования, созданного ИИ, показывает блок с переключателем «Проверено»', () => {
    renderModal(makeReq({ slug: 'ai-1', name: 'ИИ: платежи', origin: 'AI_DOCS' }));

    const block = screen.getByTestId('req-ai-review-block');
    expect(block).toHaveAttribute('data-origin', 'AI_DOCS');
    expect(block).toHaveAttribute('data-validated', 'false');
    expect(screen.getByTestId('req-ai-origin')).toHaveTextContent('ИИ-импорт из документации');

    const toggle = screen.getByTestId('req-ai-validated-toggle');
    expect(toggle).not.toBeChecked();
    // Доступность: у переключателя есть связанная подпись.
    expect(toggle).toHaveAccessibleName('Проверено');
    // Терминология: «проверено», не «валидировано».
    expect(block).toHaveTextContent('не проверено');
    expect(block.textContent ?? '').not.toMatch(/валидир/i);
    expect(screen.getByTestId('req-ai-validated-hint')).toHaveTextContent('подсветк');
  });

  it('у требования, созданного вручную, блока «Проверка» нет', () => {
    renderModal(makeReq({ slug: 'man-1', name: 'Ручное требование' }));

    expect(screen.queryByTestId('req-ai-review-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('req-ai-validated-toggle')).not.toBeInTheDocument();
  });

  it('включение отметки сохраняет aiValidated: true существующей кнопкой «Сохранить»', async () => {
    const user = userEvent.setup();
    renderModal(makeReq({ slug: 'ai-1', name: 'ИИ: платежи', origin: 'AI_DOCS' }));

    await user.click(screen.getByTestId('req-ai-validated-toggle'));
    expect(screen.getByTestId('req-ai-validated-toggle')).toBeChecked();
    expect(screen.getByTestId('req-ai-review-block')).toHaveAttribute('data-validated', 'true');

    await user.click(screen.getByTestId('req-submit'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      'p1',
      'ai-1',
      expect.objectContaining({ aiValidated: true }),
    );
    // `origin` — поле сервера: клиент его не отправляет.
    expect(update.mock.calls[0][2]).not.toHaveProperty('origin');
  });

  it('снятие отметки сохраняет aiValidated: false (действие обратимо)', async () => {
    const user = userEvent.setup();
    renderModal(
      makeReq({
        slug: 'ai-2',
        name: 'ИИ: возвраты',
        origin: 'AI_BACKLOG',
        aiValidated: true,
      }),
    );

    const toggle = screen.getByTestId('req-ai-validated-toggle');
    expect(toggle).toBeChecked();
    expect(screen.getByTestId('req-ai-origin')).toHaveTextContent('ИИ-импорт из бэклога');

    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    await user.click(screen.getByTestId('req-submit'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      'p1',
      'ai-2',
      expect.objectContaining({ aiValidated: false }),
    );
  });

  it('у ручного требования aiValidated в payload не уходит', async () => {
    const user = userEvent.setup();
    renderModal(makeReq({ slug: 'man-1', name: 'Ручное требование' }));

    await user.click(screen.getByTestId('req-submit'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2].aiValidated).toBeUndefined();
  });
});
