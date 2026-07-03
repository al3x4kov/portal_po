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
    // Load button is disabled without a key.
    expect(screen.getByTestId('ai-load-models')).toBeDisabled();
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

  it('saves the config and loads models, showing a success status', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: true });
    listModels.mockResolvedValue({ models: ['GigaChat-2-Pro', 'GigaChat-2'] });
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-secret');
    await user.click(screen.getByTestId('ai-load-models'));

    await waitFor(() =>
      expect(screen.getByTestId('ai-status')).toHaveTextContent('Подключение успешно'),
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-secret', projectId: 'proj-1' }),
    );
    // Models populate the select; typed key is cleared from the field.
    expect(screen.getByTestId('ai-model-select')).toBeInTheDocument();
    expect(screen.getByTestId('ai-key-input')).toHaveValue('');
  });

  it('shows a readable error when loading models fails', async () => {
    getConfig.mockResolvedValue({ baseURL: '', hasApiKey: false });
    saveConfig.mockResolvedValue({ baseURL: '', hasApiKey: true });
    listModels.mockRejectedValue(new Error('401 — проверьте ключ'));
    const user = userEvent.setup();
    renderAiPage();

    await user.type(await screen.findByTestId('ai-key-input'), 'sk-bad');
    await user.click(screen.getByTestId('ai-load-models'));

    await waitFor(() => {
      const status = screen.getByTestId('ai-status');
      expect(status).toHaveTextContent('Не удалось подключиться');
      expect(status).toHaveTextContent('401');
    });
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
});
