import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chat';

/**
 * Task 9 chat store: covers the in-memory conversation lifecycle and the drag
 * position setters (setFabPos / setWidgetPos) that persist the FAB/widget
 * placement while the widget is open.
 */
describe('useChatStore', () => {
  beforeEach(() => {
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

  it('open/close toggles visibility without clearing messages', () => {
    useChatStore.getState().appendMessage({ role: 'user', content: 'привет' });
    useChatStore.getState().open();
    expect(useChatStore.getState().isOpen).toBe(true);
    useChatStore.getState().close();
    expect(useChatStore.getState().isOpen).toBe(false);
    // Closing keeps the conversation (§6.1).
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('newChat clears messages and error but not the draft', () => {
    useChatStore.setState({
      messages: [{ role: 'assistant', content: 'ответ' }],
      error: 'сбой',
      draft: 'черновик',
    });
    useChatStore.getState().newChat();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().draft).toBe('черновик');
  });

  it('setFabPos stores the dragged FAB coordinates', () => {
    useChatStore.getState().setFabPos({ x: 120, y: 340 });
    expect(useChatStore.getState().fabPos).toEqual({ x: 120, y: 340 });
  });

  it('setWidgetPos stores the dragged widget coordinates', () => {
    useChatStore.getState().setWidgetPos({ x: 12, y: 48 });
    expect(useChatStore.getState().widgetPos).toEqual({ x: 12, y: 48 });
  });

  it('setModelOverride, setError and setDraft update their slices', () => {
    useChatStore.getState().setModelOverride('GigaChat-2-Pro');
    useChatStore.getState().setError('лимит запросов');
    useChatStore.getState().setDraft('текст');
    const s = useChatStore.getState();
    expect(s.modelOverride).toBe('GigaChat-2-Pro');
    expect(s.error).toBe('лимит запросов');
    expect(s.draft).toBe('текст');
  });
});
