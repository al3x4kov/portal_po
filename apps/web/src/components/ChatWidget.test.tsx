import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiChatResponse } from '@po/core';
import { ChatWidget } from './ChatWidget';
import { renderWithProviders } from '../test/utils';
import { useChatStore } from '../store/chat';

const getConfig = vi.fn();
const listModels = vi.fn();
const chat = vi.fn();
const getProject = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: { get: (...a: unknown[]) => getProject(...a) },
  requirementsApi: {},
  linksApi: {},
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    listModels: (...a: unknown[]) => listModels(...a),
    chat: (...a: unknown[]) => chat(...a),
  },
}));

const CONFIGURED = {
  baseURL: 'https://api.ai.sbt/openai/v1',
  hasApiKey: true,
  model: 'GigaChat-2-Pro',
};
const NOT_CONFIGURED = { baseURL: '', hasApiKey: false };
const MODELS = { models: ['GigaChat-2-Pro', 'GigaChat-2-Max'] };
const PROJECT_STUB = {
  id: 'proj-1',
  name: 'DPM',
  mainPath: '/Projects/DPM',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderWidget(route = '/p/proj-1'): void {
  renderWithProviders(<ChatWidget />, { route });
}

async function openWidget(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('chat-fab'));
  await screen.findByTestId('chat-widget');
}

describe('ChatWidget (Task 9)', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIGURED);
    listModels.mockReset().mockResolvedValue(MODELS);
    chat.mockReset();
    getProject.mockReset().mockResolvedValue(PROJECT_STUB);
    useChatStore.setState({
      isOpen: false,
      fabPos: null,
      widgetPos: null,
      modelOverride: null,
      messages: [],
      error: null,
      draft: '',
    });
  });

  it('shows the FAB by default and no widget', () => {
    renderWidget();
    expect(screen.getByTestId('chat-fab')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-widget')).not.toBeInTheDocument();
  });

  it('opens the widget on FAB click and hides the FAB', async () => {
    const user = userEvent.setup();
    renderWidget();
    await openWidget(user);
    expect(screen.getByTestId('chat-widget')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-fab')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-empty')).toHaveTextContent('Спросите ассистента…');
  });

  it('sends a message: user bubble, «печатает…», then assistant reply', async () => {
    let resolveChat!: (v: AiChatResponse) => void;
    chat.mockImplementation(() => new Promise<AiChatResponse>((r) => (resolveChat = r)));
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);

    await user.type(screen.getByTestId('chat-input'), 'Привет, ассистент');
    await user.click(screen.getByTestId('chat-send'));

    expect(screen.getByTestId('chat-msg-user')).toHaveTextContent('Привет, ассистент');
    expect(screen.getByTestId('chat-typing')).toHaveTextContent('печатает…');
    expect(screen.getByTestId('chat-input')).toHaveValue('');
    expect(chat).toHaveBeenCalledWith({
      projectId: 'proj-1',
      messages: [{ role: 'user', content: 'Привет, ассистент' }],
    });

    resolveChat({ message: { role: 'assistant', content: 'Здравствуйте! Чем помочь?' } });
    expect(await screen.findByTestId('chat-msg-assistant')).toHaveTextContent(
      'Здравствуйте! Чем помочь?',
    );
    expect(screen.queryByTestId('chat-typing')).not.toBeInTheDocument();
  });

  it('sends on Enter and keeps Shift+Enter as a line break', async () => {
    chat.mockResolvedValue({ message: { role: 'assistant', content: 'ok' } });
    const user = userEvent.setup();
    renderWidget();
    await openWidget(user);

    const input = screen.getByTestId('chat-input');
    await user.type(input, 'строка 1{Shift>}{Enter}{/Shift}строка 2');
    expect(chat).not.toHaveBeenCalled();
    expect(input).toHaveValue('строка 1\nстрока 2');

    await user.type(input, '{Enter}');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-msg-user')).toHaveTextContent('строка 1 строка 2');
  });

  it('passes the model override chosen in the dropdown to the request', async () => {
    chat.mockResolvedValue({ message: { role: 'assistant', content: 'ok' } });
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);

    const select = await screen.findByTestId('chat-model-select');
    // Default value = project model from config.
    await waitFor(() => expect(select).toHaveValue('GigaChat-2-Pro'));
    await user.selectOptions(select, 'GigaChat-2-Max');

    await user.type(screen.getByTestId('chat-input'), 'вопрос');
    await user.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'GigaChat-2-Max', projectId: 'proj-1' }),
      ),
    );
  });

  it('keeps the conversation when closed with X and reopened', async () => {
    chat.mockResolvedValue({ message: { role: 'assistant', content: 'Ответ бота' } });
    const user = userEvent.setup();
    renderWidget();
    await openWidget(user);

    await user.type(screen.getByTestId('chat-input'), 'Сохранись');
    await user.click(screen.getByTestId('chat-send'));
    await screen.findByTestId('chat-msg-assistant');

    await user.click(screen.getByTestId('chat-close'));
    expect(screen.queryByTestId('chat-widget')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-fab')).toBeInTheDocument();

    await openWidget(user);
    expect(screen.getByTestId('chat-msg-user')).toHaveTextContent('Сохранись');
    expect(screen.getByTestId('chat-msg-assistant')).toHaveTextContent('Ответ бота');
  });

  it('«Новый чат» clears the conversation and the error', async () => {
    useChatStore.setState({
      messages: [
        { role: 'user', content: 'старое сообщение' },
        { role: 'assistant', content: 'старый ответ' },
      ],
      error: 'старая ошибка',
    });
    const user = userEvent.setup();
    renderWidget();
    await openWidget(user);
    expect(screen.getByTestId('chat-msg-user')).toBeInTheDocument();
    expect(screen.getByTestId('chat-error')).toBeInTheDocument();

    await user.click(screen.getByTestId('chat-new'));
    expect(screen.queryByTestId('chat-msg-user')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-msg-assistant')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
  });

  it('shows a readable send error with a «Повторить» button and keeps the history', async () => {
    chat.mockRejectedValue(new Error('AI Hub недоступен (502)'));
    const user = userEvent.setup();
    renderWidget();
    await openWidget(user);

    await user.type(screen.getByTestId('chat-input'), 'вопрос в никуда');
    await user.click(screen.getByTestId('chat-send'));

    const error = await screen.findByTestId('chat-error');
    expect(error).toHaveTextContent('Не удалось отправить');
    expect(error).toHaveTextContent('AI Hub недоступен (502)');
    expect(screen.getByTestId('chat-msg-user')).toHaveTextContent('вопрос в никуда');
    expect(screen.getByTestId('chat-retry')).toBeInTheDocument();
  });

  // §2.17.3: «Повторить» re-sends the failed request in one action.
  it('«Повторить» re-sends the last question without retyping it', async () => {
    chat
      .mockRejectedValueOnce(new Error('AI Hub недоступен (502)'))
      .mockResolvedValue({ message: { role: 'assistant', content: 'Со второй попытки' } });
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);

    await user.type(screen.getByTestId('chat-input'), 'повтори меня');
    await user.click(screen.getByTestId('chat-send'));
    await screen.findByTestId('chat-error');

    await user.click(screen.getByTestId('chat-retry'));

    expect(await screen.findByTestId('chat-msg-assistant')).toHaveTextContent('Со второй попытки');
    expect(screen.queryByTestId('chat-error')).not.toBeInTheDocument();
    // Both calls carried the SAME history ending with the user question.
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenNthCalledWith(2, {
      projectId: 'proj-1',
      messages: [{ role: 'user', content: 'повтори меня' }],
    });
    // The question was not duplicated in the feed.
    expect(screen.getAllByTestId('chat-msg-user')).toHaveLength(1);
  });

  // §2.17.2: the chat context (current project) is always visible in the header.
  it('shows the current project name in the chat header', async () => {
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);
    await waitFor(() =>
      expect(screen.getByTestId('chat-project')).toHaveTextContent('Проект: DPM'),
    );
  });

  it('without an API key: empty state «Настройте AI Hub» with a CTA, composer disabled', async () => {
    getConfig.mockResolvedValue(NOT_CONFIGURED);
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);

    const select = await screen.findByTestId('chat-model-select');
    await waitFor(() => expect(select).toBeDisabled());
    expect(select).toHaveTextContent('Модель не настроена');
    expect(screen.getByTestId('chat-model-hint')).toHaveAttribute(
      'title',
      expect.stringContaining('Задайте API-ключ'),
    );
    // Empty state: icon + title + offer + CTA to the AI settings screen.
    const empty = screen.getByTestId('chat-empty');
    expect(empty).toHaveTextContent('Настройте AI Hub');
    expect(empty).toHaveTextContent(
      'Чтобы общаться с моделью о проекте, укажите ключ AI Hub и выберите модель.',
    );
    expect(screen.getByTestId('chat-open-ai-settings')).toHaveTextContent('Открыть настройки AI');

    // Composer is disabled with the reason in title (§3, pattern 1).
    const input = screen.getByTestId('chat-input');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('title', 'Настройте AI Hub, чтобы отправлять сообщения');
    const send = screen.getByTestId('chat-send');
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'Настройте AI Hub, чтобы отправлять сообщения');
    expect(listModels).not.toHaveBeenCalled();
  });

  it('send stays disabled while the input is empty', async () => {
    const user = userEvent.setup();
    renderWidget('/p/proj-1');
    await openWidget(user);
    await waitFor(() =>
      expect(screen.getByTestId('chat-model-select')).toHaveValue('GigaChat-2-Pro'),
    );
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  // ── todo_16 A3: re-request the model list, re-pick a model at any time ─────

  describe('model list refresh (A3)', () => {
    it('re-requests the list on click; a new model becomes selectable, selection kept', async () => {
      listModels
        .mockResolvedValueOnce(MODELS)
        .mockResolvedValue({ models: ['GigaChat-2-Pro', 'GigaChat-2-Max', 'GigaChat-3'] });
      const user = userEvent.setup();
      renderWidget('/p/proj-1');
      await openWidget(user);

      const select = await screen.findByTestId('chat-model-select');
      await waitFor(() => expect(select).toHaveValue('GigaChat-2-Pro'));
      expect(screen.queryByRole('option', { name: 'GigaChat-3' })).not.toBeInTheDocument();

      await user.click(screen.getByTestId('ai-models-refresh-chat'));
      await screen.findByRole('option', { name: 'GigaChat-3' });
      expect(listModels).toHaveBeenCalledTimes(2);
      // The selection survives the refresh; no notice is shown.
      expect(select).toHaveValue('GigaChat-2-Pro');
      expect(screen.queryByTestId('ai-models-notice-chat')).not.toBeInTheDocument();

      // The select stays usable — the freshly loaded model can be picked.
      await user.selectOptions(select, 'GigaChat-3');
      expect(select).toHaveValue('GigaChat-3');
    });

    it('vanished selection falls back to the project model with a notice; requests use it', async () => {
      listModels.mockResolvedValueOnce(MODELS).mockResolvedValue({ models: ['GigaChat-2-Pro'] });
      chat.mockResolvedValue({ message: { role: 'assistant', content: 'ok' } });
      const user = userEvent.setup();
      renderWidget('/p/proj-1');
      await openWidget(user);

      const select = await screen.findByTestId('chat-model-select');
      await waitFor(() => expect(select).toHaveValue('GigaChat-2-Pro'));
      await user.selectOptions(select, 'GigaChat-2-Max');

      await user.click(screen.getByTestId('ai-models-refresh-chat'));
      await waitFor(() => expect(select).toHaveValue('GigaChat-2-Pro'));
      const notice = screen.getByTestId('ai-models-notice-chat');
      expect(notice).toHaveTextContent('GigaChat-2-Max');
      expect(notice).toHaveTextContent('GigaChat-2-Pro');

      // Subsequent chat turns use the auto-picked model.
      await user.type(screen.getByTestId('chat-input'), 'вопрос');
      await user.click(screen.getByTestId('chat-send'));
      await waitFor(() =>
        expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'GigaChat-2-Pro' })),
      );
    });

    it('refresh failure shows an inline error and keeps the selection', async () => {
      listModels
        .mockResolvedValueOnce(MODELS)
        .mockRejectedValue(new Error('AI Hub недоступен (502)'));
      const user = userEvent.setup();
      renderWidget('/p/proj-1');
      await openWidget(user);

      const select = await screen.findByTestId('chat-model-select');
      await waitFor(() => expect(select).toHaveValue('GigaChat-2-Pro'));

      await user.click(screen.getByTestId('ai-models-refresh-chat'));
      const notice = await screen.findByTestId('ai-models-notice-chat');
      expect(notice).toHaveTextContent('Не удалось обновить список моделей');
      expect(notice).toHaveTextContent('502');
      expect(select).toHaveValue('GigaChat-2-Pro');
    });
  });

  // PO-T3: Escape collapses the expanded widget, exactly like ✕ — the
  // conversation AND the unsent draft survive (draft lives in the store).
  describe('Escape (PO-T3)', () => {
    it('Escape with focus inside the panel collapses the widget (FAB is back)', async () => {
      const user = userEvent.setup();
      renderWidget();
      await openWidget(user);

      await user.click(screen.getByTestId('chat-input'));
      await user.keyboard('{Escape}');

      expect(screen.queryByTestId('chat-widget')).not.toBeInTheDocument();
      expect(screen.getByTestId('chat-fab')).toBeInTheDocument();
    });

    it('Escape keeps the conversation and the typed draft on reopen', async () => {
      chat.mockResolvedValue({ message: { role: 'assistant', content: 'Ответ бота' } });
      const user = userEvent.setup();
      renderWidget();
      await openWidget(user);

      await user.type(screen.getByTestId('chat-input'), 'Первый вопрос');
      await user.click(screen.getByTestId('chat-send'));
      await screen.findByTestId('chat-msg-assistant');

      // Draft typed but NOT sent — Escape in the textarea must not lose it.
      await user.type(screen.getByTestId('chat-input'), 'недописанный черновик');
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('chat-widget')).not.toBeInTheDocument();

      await openWidget(user);
      expect(screen.getByTestId('chat-msg-user')).toHaveTextContent('Первый вопрос');
      expect(screen.getByTestId('chat-msg-assistant')).toHaveTextContent('Ответ бота');
      expect(screen.getByTestId('chat-input')).toHaveValue('недописанный черновик');
    });

    it('Escape with focus outside the widget does not close it', async () => {
      const user = userEvent.setup();
      renderWidget();
      await openWidget(user);

      // After the FAB unmounts focus falls back to <body>, i.e. OUTSIDE the
      // panel — Escape there must be ignored (no global document listener).
      expect(screen.getByTestId('chat-widget')).not.toContainElement(
        document.activeElement as HTMLElement,
      );
      await user.keyboard('{Escape}');

      expect(screen.getByTestId('chat-widget')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-fab')).not.toBeInTheDocument();
    });
  });
});
