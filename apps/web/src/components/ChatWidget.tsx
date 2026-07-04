import { useEffect, useMemo, useRef } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { AI_CHAT_HISTORY_LIMIT, type AiChatMessage, type AiChatRequest } from '@po/core';
import { useAiChat, useAiConfig, useAiModels } from '../api/hooks';
import { errorMessage } from '../api/client';
import { useChatStore, type ChatPosition } from '../store/chat';

/**
 * Task 9: floating AI chat, mounted once in App so it is available on EVERY
 * screen. Collapsed = draggable FAB; a click (pointer travel < 5px) expands it
 * into a draggable 380x560 card. Closing keeps the conversation (store lives
 * in memory); «Новый чат» clears it. Mirrors design-out/task9/chat-widget.html.
 */

const DRAG_THRESHOLD_PX = 5;
const VIEWPORT_MARGIN_PX = 8;
const DEFAULT_OFFSET_PX = 24;

const MODEL_HINT =
  'Задайте API-ключ на экране AI (меню проекта → AI), затем выберите модель — и чат заработает.';

/* ── drag helper ─────────────────────────────────────────────────────────── */

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  moved: boolean;
}

function clampToViewport(x: number, y: number, w: number, h: number): ChatPosition {
  const maxX = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - w - VIEWPORT_MARGIN_PX);
  const maxY = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - h - VIEWPORT_MARGIN_PX);
  return {
    x: Math.min(Math.max(x, VIEWPORT_MARGIN_PX), maxX),
    y: Math.min(Math.max(y, VIEWPORT_MARGIN_PX), maxY),
  };
}

interface DraggableOptions {
  /** Element that is repositioned (its rect anchors the drag). */
  targetRef: React.RefObject<HTMLElement | null>;
  setPos: (pos: ChatPosition) => void;
  /** Skip drags that start on interactive children (header controls). */
  ignoreInteractive?: boolean;
  /** Called on release; `moved` distinguishes a drag from a plain click. */
  onRelease?: (moved: boolean) => void;
}

interface DragHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
}

/** Pointer-events drag with a 5px click-vs-drag threshold (spec §1.1/§1.2). */
function useDraggable({
  targetRef,
  setPos,
  ignoreInteractive,
  onRelease,
}: DraggableOptions): DragHandlers {
  const session = useRef<DragSession | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (ignoreInteractive && (e.target as Element).closest('button, select, textarea, input, a')) {
      return;
    }
    const el = targetRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    session.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / older browsers */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const d = session.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const el = targetRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampToViewport(d.origX + dx, d.origY + dy, rect.width, rect.height));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>): void => {
    const d = session.current;
    if (!d || d.pointerId !== e.pointerId) return;
    session.current = null;
    onRelease?.(d.moved);
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}

function positionStyle(pos: ChatPosition | null): React.CSSProperties {
  return pos
    ? { left: pos.x, top: pos.y }
    : { right: DEFAULT_OFFSET_PX, bottom: DEFAULT_OFFSET_PX };
}

/* ── icons (inline SVG, per mockup) ──────────────────────────────────────── */

function MessageIcon(): React.ReactElement {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function BotIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v3" />
      <path d="M9 15h.01M15 15h.01" />
    </svg>
  );
}

function UserIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function PlusIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/* ── message bubbles ─────────────────────────────────────────────────────── */

function BotAvatar(): React.ReactElement {
  return (
    <div
      className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
      style={{ background: 'var(--color-primary)', color: '#fff' }}
      aria-hidden="true"
    >
      <BotIcon />
    </div>
  );
}

function UserAvatar(): React.ReactElement {
  return (
    <div
      className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
      style={{ background: 'var(--color-border)', color: 'var(--color-text)' }}
      aria-hidden="true"
    >
      <UserIcon />
    </div>
  );
}

const BOT_BUBBLE_STYLE: React.CSSProperties = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text)',
};

function Bubble({ message }: { message: AiChatMessage }): React.ReactElement {
  const isUser = message.role === 'user';
  return (
    <div
      className={`flex items-start gap-2 ${isUser ? 'justify-end' : ''}`}
      data-testid={isUser ? 'chat-msg-user' : 'chat-msg-assistant'}
    >
      {!isUser && <BotAvatar />}
      <div
        className="max-w-[78%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed"
        style={isUser ? { background: 'var(--color-primary)', color: '#fff' } : BOT_BUBBLE_STYLE}
      >
        {message.content}
      </div>
      {isUser && <UserAvatar />}
    </div>
  );
}

/* ── collapsed state: FAB ────────────────────────────────────────────────── */

function ChatFab(): React.ReactElement {
  const fabPos = useChatStore((s) => s.fabPos);
  const setFabPos = useChatStore((s) => s.setFabPos);
  const open = useChatStore((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  // A completed drag must not also fire the click that follows pointerup.
  const suppressClick = useRef(false);

  const drag = useDraggable({
    targetRef: ref,
    setPos: setFabPos,
    onRelease: (moved) => {
      if (moved) suppressClick.current = true;
    },
  });

  return (
    <button
      ref={ref}
      type="button"
      className="fixed z-50 flex h-12 w-12 touch-none items-center justify-center rounded-full text-white"
      style={{
        background: 'var(--color-primary)',
        boxShadow: 'var(--shadow-lg)',
        ...positionStyle(fabPos),
      }}
      title="AI-чат"
      aria-label="Открыть AI-чат"
      data-testid="chat-fab"
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        open();
      }}
    >
      <MessageIcon />
    </button>
  );
}

/* ── expanded state: chat panel ──────────────────────────────────────────── */

const ICON_BTN_CLASS =
  'flex h-7 w-7 flex-none items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)]';

function ChatPanel({ projectId }: { projectId: string | undefined }): React.ReactElement {
  const widgetPos = useChatStore((s) => s.widgetPos);
  const setWidgetPos = useChatStore((s) => s.setWidgetPos);
  const modelOverride = useChatStore((s) => s.modelOverride);
  const setModelOverride = useChatStore((s) => s.setModelOverride);
  const messages = useChatStore((s) => s.messages);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const error = useChatStore((s) => s.error);
  const setError = useChatStore((s) => s.setError);
  const newChat = useChatStore((s) => s.newChat);
  const close = useChatStore((s) => s.close);
  // Draft lives in the store so ✕/Escape collapse never loses typed text.
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);

  const configQuery = useAiConfig(projectId);
  const config = configQuery.data;
  const configured = Boolean(config?.hasApiKey);
  // Models are requested only once a key is stored (same rule as AiPage).
  const modelsQuery = useAiModels(configured);

  const chatMut = useAiChat();
  const pending = chatMut.isPending;

  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const drag = useDraggable({ targetRef: cardRef, setPos: setWidgetPos, ignoreInteractive: true });

  // Widget-selected model wins over the per-project one (PO decision §6.3).
  const selectedModel = modelOverride ?? config?.model ?? '';
  const modelReady = configured && selectedModel.length > 0;
  const canSend = modelReady && !pending && draft.trim().length > 0;

  // Loaded models + the currently selected one, so the value is never lost.
  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsQuery.data?.models ?? []);
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [modelsQuery.data, selectedModel]);

  // Autoscroll to the latest entry (message, typing indicator or error).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, error]);

  const resizeInput = (): void => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
  };

  // A draft restored from the store (after ✕/Escape) may span several lines.
  useEffect(() => {
    resizeInput();
  }, []);

  const send = (): void => {
    const content = draft.trim();
    if (!canSend || content.length === 0) return;
    const userMessage: AiChatMessage = { role: 'user', content };
    // Trailing-N history INCLUDING the new message (server limit, §6.4).
    const history = [...messages, userMessage].slice(-AI_CHAT_HISTORY_LIMIT);
    const request: AiChatRequest = { messages: history };
    if (projectId) request.projectId = projectId;
    if (modelOverride) request.model = modelOverride;

    appendMessage(userMessage);
    setError(null);
    setDraft('');
    const el = inputRef.current;
    if (el) el.style.height = 'auto';

    chatMut.mutate(request, {
      onSuccess: (res) => appendMessage(res.message),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <div
      ref={cardRef}
      className="fixed z-50 flex flex-col"
      style={{
        width: 'min(380px, calc(100vw - 16px))',
        height: 'min(560px, calc(100vh - 16px))',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-lg)',
        ...positionStyle(widgetPos),
      }}
      role="dialog"
      aria-label="AI-чат"
      data-testid="chat-widget"
      onKeyDown={(e) => {
        // PO-T3: Escape pressed anywhere INSIDE the panel collapses the widget
        // (conversation and draft are kept in the store, same as ✕). Handled on
        // the panel itself — not on document — so Escape outside the chat keeps
        // reaching modals/pages, and stopPropagation shields their handlers
        // when the chat consumes the key.
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      {/* Header: drag handle + model select + new chat + close */}
      <div
        className="flex touch-none items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--color-border)', cursor: 'move' }}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
      >
        {configured ? (
          <div className="min-w-0 flex-1">
            <select
              className="input cursor-pointer py-1 text-[13px]"
              title="Модель для этого чата"
              aria-label="Модель для этого чата"
              data-testid="chat-model-select"
              value={selectedModel}
              onChange={(e) => setModelOverride(e.target.value)}
            >
              {selectedModel.length === 0 ? <option value="">— выберите модель —</option> : null}
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="min-w-0 flex-1" title={MODEL_HINT} data-testid="chat-model-hint">
            <select
              className="input cursor-not-allowed py-1 text-[13px] opacity-50"
              aria-label="Модель для этого чата"
              disabled
              data-testid="chat-model-select"
            >
              <option>Модель не настроена</option>
            </select>
          </div>
        )}
        <button
          type="button"
          className={ICON_BTN_CLASS}
          style={{ color: 'var(--color-text-3)' }}
          title="Новый чат (очистить переписку)"
          aria-label="Новый чат"
          data-testid="chat-new"
          onClick={newChat}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className={ICON_BTN_CLASS}
          style={{ color: 'var(--color-text-3)' }}
          title="Свернуть (переписка сохранится)"
          aria-label="Закрыть чат"
          data-testid="chat-close"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Message feed */}
      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="chat-messages"
        aria-live="polite"
      >
        {messages.length === 0 && !pending ? (
          <div
            className="flex h-full items-center justify-center px-6 text-center text-sm"
            style={{ color: 'var(--color-text-3)' }}
            data-testid="chat-empty"
          >
            {configured
              ? 'Спросите ассистента…'
              : 'Спросите ассистента… Для отправки сообщений настройте AI Hub.'}
          </div>
        ) : (
          messages.map((m, i) => <Bubble key={i} message={m} />)
        )}
        {pending ? (
          <div className="flex items-start gap-2" data-testid="chat-typing">
            <BotAvatar />
            <div
              className="max-w-[78%] rounded-xl px-3 py-2 text-[13px] leading-relaxed"
              style={{ ...BOT_BUBBLE_STYLE, color: 'var(--color-text-3)' }}
            >
              печатает…
            </div>
          </div>
        ) : null}
        {error ? (
          <div
            className="rounded-lg p-2 text-xs"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            role="alert"
            data-testid="chat-error"
          >
            {error}
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div
        className="flex items-end gap-2 px-3 py-2"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <textarea
          ref={inputRef}
          className="input max-h-20 min-h-[38px] flex-1 resize-none py-2"
          rows={1}
          maxLength={8000}
          placeholder="Сообщение… (Enter — отправить)"
          aria-label="Сообщение ассистенту"
          data-testid="chat-input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            resizeInput();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary px-3 py-2 text-sm"
          data-testid="chat-send"
          disabled={!canSend}
          title={!modelReady ? 'Настройте AI Hub' : undefined}
          onClick={send}
        >
          Отправить
        </button>
      </div>
    </div>
  );
}

/* ── entry point ─────────────────────────────────────────────────────────── */

export function ChatWidget(): React.ReactElement {
  const isOpen = useChatStore((s) => s.isOpen);
  const location = useLocation();
  // The widget lives outside <Routes>, so the project id (if a project screen
  // is open) is derived from the path: /p/:id[/...].
  const match = matchPath({ path: '/p/:id', end: false }, location.pathname);
  const projectId = match?.params.id;

  return isOpen ? <ChatPanel projectId={projectId} /> : <ChatFab />;
}
