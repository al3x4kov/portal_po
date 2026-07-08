import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { RequirementModal } from './RequirementModal';
import { renderWithProviders } from '../test/utils';

const checkName = vi.fn();
const getConfig = vi.fn();
const generateDescription = vi.fn();

vi.mock('../api/endpoints', () => ({
  requirementsApi: {
    checkName: (...a: unknown[]) => checkName(...a),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  },
  projectsApi: {},
  linksApi: { create: vi.fn(), remove: vi.fn() },
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    saveConfig: vi.fn(),
    listModels: vi.fn(),
    generateDescription: (...a: unknown[]) => generateDescription(...a),
  },
}));

const CONFIG_READY = {
  baseURL: 'https://api.ai.sbt/openai/v1',
  hasApiKey: true,
  model: 'GigaChat-2-Pro',
};
const CONFIG_NONE = { baseURL: '', hasApiKey: false };

function renderModal(): void {
  renderWithProviders(
    <Routes>
      <Route
        path="/p/:id"
        element={<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />}
      />
    </Routes>,
    { route: '/p/p1' },
  );
}

/**
 * ФТ-E3: описание и AI-генерация живут на вкладке «Описание и сценарии».
 * Сначала имя (вкладка «Основное» активна по умолчанию), затем переход на
 * вкладку описания, чтобы её элементы стали видимы для взаимодействия.
 */
async function typeNameThenOpenDescTab(user: UserEvent, name: string): Promise<void> {
  await user.type(screen.getByTestId('req-name'), name);
  await user.click(screen.getByTestId('req-tab-desc'));
}

describe('RequirementModal — AI generation (T-803)', () => {
  beforeEach(() => {
    checkName.mockReset().mockResolvedValue({ available: true, slug: 'x' });
    getConfig.mockReset();
    generateDescription.mockReset();
  });

  it('disables the generation button and shows a setup link without config', async () => {
    getConfig.mockResolvedValue(CONFIG_NONE);
    renderModal();
    const btn = await screen.findByTestId('ai-gen-open');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('ai-gen-setup-link')).toHaveAttribute('href', '/p/p1/ai');
  });

  it('T4: «Дополнить» appends the preview to the description on a new line', async () => {
    getConfig.mockResolvedValue(CONFIG_READY);
    generateDescription.mockResolvedValue({ description: 'Сгенерированный текст описания.' });
    const user = userEvent.setup();
    renderModal();

    // Requirement needs a name for generation to be enabled.
    await typeNameThenOpenDescTab(user, 'Валидация имени');
    await user.type(screen.getByTestId('req-description'), 'Исходное описание.');

    await user.click(await screen.findByTestId('ai-gen-open'));
    await user.type(screen.getByTestId('ai-gen-hint'), 'акцент на валидации');
    await user.click(screen.getByTestId('ai-gen-submit'));

    const preview = await screen.findByTestId('ai-gen-preview');
    expect(preview).toHaveTextContent('Сгенерированный текст описания.');
    // Request carried the requirement context + hint.
    expect(generateDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        requirement: expect.objectContaining({ name: 'Валидация имени', type: 'FUNCTION' }),
        userHint: 'акцент на валидации',
      }),
    );

    await user.click(screen.getByTestId('ai-gen-append'));

    // Append with a newline, not overwrite.
    expect(screen.getByTestId('req-description')).toHaveValue(
      'Исходное описание.\nСгенерированный текст описания.',
    );
    // Panel collapses back after apply.
    expect(screen.queryByTestId('ai-gen-preview')).not.toBeInTheDocument();
  });

  it('T4: «Заменить описание» overwrites the current description', async () => {
    getConfig.mockResolvedValue(CONFIG_READY);
    generateDescription.mockResolvedValue({ description: 'Новый текст.' });
    const user = userEvent.setup();
    renderModal();

    await typeNameThenOpenDescTab(user, 'Требование');
    await user.type(screen.getByTestId('req-description'), 'Старый текст.');
    await user.click(await screen.findByTestId('ai-gen-open'));
    await user.click(screen.getByTestId('ai-gen-submit'));
    await screen.findByTestId('ai-gen-preview');
    await user.click(screen.getByTestId('ai-gen-apply'));

    expect(screen.getByTestId('req-description')).toHaveValue('Новый текст.');
  });

  it('uses the generated text as-is when the description was empty', async () => {
    getConfig.mockResolvedValue(CONFIG_READY);
    generateDescription.mockResolvedValue({ description: 'Только сгенерированное.' });
    const user = userEvent.setup();
    renderModal();

    await typeNameThenOpenDescTab(user, 'Новое требование');
    await user.click(await screen.findByTestId('ai-gen-open'));
    await user.click(screen.getByTestId('ai-gen-submit'));
    await screen.findByTestId('ai-gen-preview');
    await user.click(screen.getByTestId('ai-gen-apply'));

    expect(screen.getByTestId('req-description')).toHaveValue('Только сгенерированное.');
  });

  it('cancels the panel without touching the description', async () => {
    getConfig.mockResolvedValue(CONFIG_READY);
    const user = userEvent.setup();
    renderModal();

    await typeNameThenOpenDescTab(user, 'Требование');
    await user.type(screen.getByTestId('req-description'), 'Не трогать.');
    await user.click(await screen.findByTestId('ai-gen-open'));
    await user.click(screen.getByTestId('ai-gen-cancel'));

    expect(screen.queryByTestId('ai-gen-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('req-description')).toHaveValue('Не трогать.');
  });

  it('shows a readable error and leaves the description unchanged on failure', async () => {
    getConfig.mockResolvedValue(CONFIG_READY);
    generateDescription.mockRejectedValue(new Error('AI Hub недоступен (тайм-аут)'));
    const user = userEvent.setup();
    renderModal();

    await typeNameThenOpenDescTab(user, 'Требование');
    await user.type(screen.getByTestId('req-description'), 'Исходное.');
    await user.click(await screen.findByTestId('ai-gen-open'));
    await user.click(screen.getByTestId('ai-gen-submit'));

    const err = await screen.findByTestId('ai-gen-error');
    expect(err).toHaveTextContent('AI Hub недоступен');
    expect(screen.getByTestId('req-description')).toHaveValue('Исходное.');
    expect(screen.queryByTestId('ai-gen-preview')).not.toBeInTheDocument();
  });
});
