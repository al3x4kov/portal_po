import { create } from 'zustand';
import type { AiChatMessage } from '@po/core';

/** Screen coordinates of a dragged element; `null` = default corner slot. */
export interface ChatPosition {
  x: number;
  y: number;
}

/**
 * Task 9: AI chat widget state. Lives in memory only (PO decision §6.1/§6.6):
 * the conversation survives navigation between screens but not a page reload.
 * Closing the widget (`close`) intentionally KEEPS `messages`; only `newChat`
 * clears the conversation and any displayed error.
 */
interface ChatState {
  /** Widget expanded (true) vs collapsed to the FAB (false). */
  isOpen: boolean;
  /** FAB position after dragging; null = default bottom-right corner. */
  fabPos: ChatPosition | null;
  /** Widget position after dragging; null = default bottom-right corner. */
  widgetPos: ChatPosition | null;
  /** Model chosen in the widget dropdown; overrides the project model (§6.3). */
  modelOverride: string | null;
  /**
   * Переключатель «Учитывать требования проекта»: диалог с моделью получает
   * ФТ/НФТ текущего проекта (сервер укладывает их в бюджет — целиком для
   * малых проектов, релевантной выборкой для 1000–2000 требований).
   * Выключен по умолчанию; переживает сворачивание виджета, как и черновик.
   */
  projectContext: boolean;
  /** Full visible conversation (requests send only the trailing N). */
  messages: AiChatMessage[];
  /** Human-readable send error shown in the feed; history is kept. */
  error: string | null;
  /**
   * Unsent composer text. Lives in the store (not component state) so that
   * collapsing the widget — via ✕ or Escape (PO-T3) — never loses the draft.
   */
  draft: string;

  open: () => void;
  close: () => void;
  newChat: () => void;
  appendMessage: (message: AiChatMessage) => void;
  setModelOverride: (model: string | null) => void;
  setProjectContext: (on: boolean) => void;
  setFabPos: (pos: ChatPosition) => void;
  setWidgetPos: (pos: ChatPosition) => void;
  setError: (error: string | null) => void;
  setDraft: (draft: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  isOpen: false,
  fabPos: null,
  widgetPos: null,
  modelOverride: null,
  projectContext: false,
  messages: [],
  error: null,
  draft: '',

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  newChat: () => set({ messages: [], error: null }),
  appendMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setModelOverride: (modelOverride) => set({ modelOverride }),
  setProjectContext: (projectContext) => set({ projectContext }),
  setFabPos: (fabPos) => set({ fabPos }),
  setWidgetPos: (widgetPos) => set({ widgetPos }),
  setError: (error) => set({ error }),
  setDraft: (draft) => set({ draft }),
}));
