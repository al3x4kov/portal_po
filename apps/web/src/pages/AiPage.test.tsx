import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AiPage } from './AiPage';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';

const getProject = vi.fn();
const listRequirements = vi.fn();
const getConfig = vi.fn();
const saveConfig = vi.fn();
const listModels = vi.fn();
const generateDescription = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: { get: (...a: unknown[]) => getProject(...a) },
  requirementsApi: { list: (...a: unknown[]) => listRequirements(...a) },
  linksApi: {},
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    saveConfig: (...a: unknown[]) => saveConfig(...a),
    listModels: (...a: unknown[]) => listModels(...a),
    generateDescription: (...a: unknown[]) => generateDescription(...a),
  },
}));

const PROJECT_STUB = {
  id: 'proj-1',
  name: 'DPM',
  mainPath: '/Projects/DPM',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderAiPage(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/ai" element={<AiPage />} />
    </Routes>,
    { route: '/p/proj-1/ai' },
  );
}

describe('AiPage (T-803)', () => {
  beforeEach(() => {
    getProject.mockReset().mockResolvedValue(PROJECT_STUB);
    listRequirements
      .mockReset()
      .mockResolvedValue({ requirements: [], broken: [], incomplete: [] });
    getConfig.mockReset();
    saveConfig.mockReset();
    listModels.mockReset();
    generateDescription.mockReset();
    useUiStore.setState({ modal: null });
  });

  it('shows the default Base URL and an empty-state hint when no key is stored', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    renderAiPage();
    await screen.findByTestId('ai-page');

    expect(screen.getByTestId('ai-baseurl-input')).toHaveValue('https://api.ai.sbt/openai/v1');
    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Введите API-ключ'),
    );
    // Model refresh is disabled without a key; the ONE save button is there.
    expect(screen.getByTestId('ai-models-refresh')).toBeDisabled();
    expect(screen.getByTestId('ai-save')).toHaveTextContent('Сохранить');
  });

  it('shows "ключ сохранён" when the server reports hasApiKey', async () => {
    getConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true });
    renderAiPage();
    expect(await screen.findByTestId('ai-key-saved')).toBeInTheDocument();
    // No plaintext key value is rendered.
    expect(screen.getByTestId('ai-key-input')).toHaveValue('');
  });

  it('toggles key visibility between password and text', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    const user = userEvent.setup();
    renderAiPage();
    const input = await screen.findByTestId('ai-key-input');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByTestId('ai-key-toggle'));
    expect(input).toHaveAttribute('type', 'text');
  });

  it('«Обновить список» with a freshly typed key saves it first, then loads models', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true });
    listModels.mockResolvedValue({ models: ['GigaChat-2-Pro', 'GigaChat-2'] });
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-secret');
    await user.click(screen.getByTestId('ai-models-refresh'));

    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Подключение успешно'),
    );
    // Russian plural forms: 1 модель / 2 модели / 5 моделей.
    expect(screen.getByTestId('ai-status')).toHaveTextContent('загружено 2 модели');
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-secret', projectId: 'proj-1' }),
    );
    // Models populate the select; typed key is cleared from the field.
    expect(screen.getByTestId('ai-model-select')).toBeInTheDocument();
    expect(screen.getByTestId('ai-key-input')).toHaveValue('');
  });

  it('shows a readable error under the save button when loading models fails', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: '', hasApiKey: true });
    listModels.mockRejectedValue(new Error('401 — проверьте ключ'));
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-bad');
    await user.click(screen.getByTestId('ai-models-refresh'));

    await waitFor(() => {
      const status = screen.getByTestId('ai-status');
      expect(status).toHaveTextContent('Не удалось подключиться');
      expect(status).toHaveTextContent('401');
    });
  });

  // ── §2.16.1/§2.16.4: the ONE save button + status right under it ──────────

  it('«Сохранить» writes key, model and base URL together and reports «Настройки сохранены»', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true });
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-secret');
    await user.click(screen.getByTestId('ai-model-mode-manual'));
    await user.type(screen.getByTestId('ai-model-manual'), 'GigaChat-2-Pro');
    await user.click(screen.getByTestId('ai-save'));

    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Настройки сохранены'),
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-secret',
        model: 'GigaChat-2-Pro',
        baseURL: 'https://api.ai.sbt/openai/v1',
        projectId: 'proj-1',
      }),
    );
    expect(screen.getByTestId('ai-key-input')).toHaveValue('');
  });

  it('save failure: danger status «Настройки не сохранены» under the button', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockRejectedValue(new Error('401 Unauthorized'));
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-bad');
    await user.click(screen.getByTestId('ai-save'));

    await waitFor(() => {
      const status = screen.getByTestId('ai-status');
      expect(status).toHaveTextContent('Не удалось подключиться');
      expect(status).toHaveTextContent('401 Unauthorized');
      expect(status).toHaveTextContent('Настройки не сохранены');
    });
  });

  // ── Task 10: delete stored API key ─────────────────────────────────────────

  it('hides the delete-key button when no key is stored', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    renderAiPage();
    await screen.findByTestId('ai-page');
    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Введите API-ключ'),
    );
    expect(screen.queryByTestId('ai-delete-key')).not.toBeInTheDocument();
  });

  it('deletes the key after confirmation and returns to the empty state', async () => {
    // First fetch: key stored; refetch after invalidation: key gone.
    getConfig
      .mockResolvedValueOnce({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true })
      .mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: false });
    const user = userEvent.setup();
    renderAiPage();

    await user.click(await screen.findByTestId('ai-delete-key'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Удалить API-ключ?');
    expect(dialog).toHaveTextContent('Выбранные модели проектов сохранятся');

    await user.click(screen.getByTestId('confirm-dialog-confirm'));

    // Exactly { apiKey: null } — '' / undefined mean "keep the key" (Task 8).
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith({ apiKey: null }));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument());
    // Config invalidation refetches hasApiKey=false → empty state is back.
    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Введите API-ключ'),
    );
    expect(screen.queryByTestId('ai-key-saved')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-delete-key')).not.toBeInTheDocument();
  });

  it('cancelling the delete confirmation sends nothing', async () => {
    getConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true });
    const user = userEvent.setup();
    renderAiPage();

    await user.click(await screen.findByTestId('ai-delete-key'));
    await screen.findByTestId('confirm-dialog');
    await user.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument());
    expect(saveConfig).not.toHaveBeenCalled();
    // Key is still reported as stored.
    expect(screen.getByTestId('ai-key-saved')).toBeInTheDocument();
  });

  it('allows manual model id entry as a fallback', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    const user = userEvent.setup();
    renderAiPage();

    await user.click(await screen.findByTestId('ai-model-mode-manual'));
    const manual = screen.getByTestId('ai-model-manual');
    await user.type(manual, 'Custom-Model');
    expect(manual).toHaveValue('Custom-Model');
  });

  // ── todo_16 A3: re-request the model list, re-pick a model at any time ─────

  describe('model list refresh (A3)', () => {
    const STORED = {
      baseURL: 'https://api.ai.sbt/openai/v1',
      hasApiKey: true,
      model: 'GigaChat-2',
    };

    it('refresh button is disabled until a key is provided', async () => {
      getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
      renderAiPage();
      await screen.findByTestId('ai-page');
      expect(screen.getByTestId('ai-models-refresh')).toBeDisabled();
    });

    it('re-requests the list on click and keeps the current selection', async () => {
      getConfig.mockResolvedValue(STORED);
      listModels.mockResolvedValue({ models: ['GigaChat-2-Pro', 'GigaChat-2'] });
      const user = userEvent.setup();
      renderAiPage();

      // Only the saved model until the list is loaded; no auto-fetch on mount.
      const select = await screen.findByTestId('ai-model-select');
      expect(listModels).not.toHaveBeenCalled();

      await user.click(screen.getByTestId('ai-models-refresh'));
      await screen.findByRole('option', { name: 'GigaChat-2-Pro' });
      expect(listModels).toHaveBeenCalledTimes(1);
      // The stored selection survives the refresh; no notice is shown.
      expect(select).toHaveValue('GigaChat-2');
      expect(screen.queryByTestId('ai-models-notice')).not.toBeInTheDocument();

      // The select stays usable — another model can be picked at any time.
      await user.selectOptions(select, 'GigaChat-2-Pro');
      expect(select).toHaveValue('GigaChat-2-Pro');
    });

    it('vanished model: falls back to the first one and shows a notice', async () => {
      getConfig.mockResolvedValue({ ...STORED, model: 'Old-Model' });
      listModels.mockResolvedValue({ models: ['GigaChat-2-Pro'] });
      const user = userEvent.setup();
      renderAiPage();

      await screen.findByTestId('ai-model-select');
      await user.click(screen.getByTestId('ai-models-refresh'));

      await waitFor(() =>
        expect(screen.getByTestId('ai-model-select')).toHaveValue('GigaChat-2-Pro'),
      );
      const notice = screen.getByTestId('ai-models-notice');
      expect(notice).toHaveTextContent('Old-Model');
      expect(notice).toHaveTextContent('GigaChat-2-Pro');
    });

    it('refresh failure shows an inline error and keeps the selection', async () => {
      getConfig.mockResolvedValue(STORED);
      listModels.mockRejectedValue(new Error('AI Hub недоступен (502)'));
      const user = userEvent.setup();
      renderAiPage();

      const select = await screen.findByTestId('ai-model-select');
      await user.click(screen.getByTestId('ai-models-refresh'));

      const notice = await screen.findByTestId('ai-models-notice');
      expect(notice).toHaveTextContent('Не удалось обновить список моделей');
      expect(notice).toHaveTextContent('502');
      expect(select).toHaveValue('GigaChat-2');
    });
  });
});
