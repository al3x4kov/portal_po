import type { AiChatCompletionParams } from '../AiHubService.js';
import { shortenText } from './text.js';

/*
 * Технические детали AI-вызова для скачиваемого лога задания (разбор NET-02).
 * Жалоба PO: при статусе terminated с NET-02 в логе не видно, ЧТО отправлялось
 * и КАКОЙ ответ вернулся. Эти хелперы собирают компактные однострочники:
 * запрос — endpoint, модель, параметры и превью сообщений; ответ — HTTP-статус,
 * тело ошибки и цепочка причин (SDK прячет реальную транспортную ошибку в
 * `cause`). Секреты здесь НЕ фильтруются — вызывающая сторона обязана прогнать
 * строку через `sanitize(…, apiKey)` перед записью в лог.
 */

/** Превью содержимого одного сообщения запроса в логе, символов. */
const MESSAGE_PREVIEW_CHARS = 500;
/** Превью тела ответа/ошибки апстрима в логе, символов. */
const BODY_PREVIEW_CHARS = 1500;

/**
 * Одна строка «что отправлялось»: endpoint (chat/completions на базовом URL из
 * настроек), модель, параметры генерации, режим response_format и размер
 * промпта по ролям + превью последнего сообщения (обычно фрагмент документа).
 */
export function describeAiRequest(baseURL: string, params: AiChatCompletionParams): string {
  const totalChars = params.messages.reduce((sum, m) => sum + m.content.length, 0);
  const roles = params.messages.map((m) => `${m.role}:${m.content.length}`).join(', ');
  const format =
    typeof params.response_format?.type === 'string' ? String(params.response_format.type) : 'нет';
  const last = params.messages[params.messages.length - 1];
  return (
    `POST ${baseURL.replace(/\/+$/, '')}/chat/completions | модель: ${params.model} | ` +
    `temperature: ${params.temperature} | max_tokens: ${params.max_tokens}` +
    (params.top_p !== undefined ? ` | top_p: ${params.top_p}` : '') +
    ` | response_format: ${format} | сообщений: ${params.messages.length} ` +
    `(${totalChars} символов; ${roles})` +
    (last
      ? ` | последнее сообщение (${last.role}): «${shortenText(last.content, MESSAGE_PREVIEW_CHARS)}»`
      : '')
  );
}

/** Walk the `cause` chain collecting readable "message (code)" links. */
function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur != null && i < 6; i++) {
    const e = cur as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const msg = typeof e.message === 'string' && e.message ? e.message : String(cur);
    const code = typeof e.code === 'string' && e.code ? ` (${e.code})` : '';
    const line = `${msg}${code}`;
    if (out[out.length - 1] !== line) out.push(line);
    cur = e.cause;
  }
  return out;
}

/** `x-request-id` заголовок ответа, когда SDK его сохранил (объект или Headers). */
function requestIdOf(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const viaGet = (headers as { get?: (k: string) => unknown }).get?.('x-request-id');
  const raw = viaGet ?? (headers as Record<string, unknown>)['x-request-id'];
  return typeof raw === 'string' && raw ? raw : undefined;
}

/**
 * Одна строка «какой вернулся ответ» для неуспешного вызова: HTTP-статус,
 * request id, тело ошибки апстрима (усечённый JSON — SDK кладёт распарсенное
 * тело в `error`) и цепочка причин до реального транспортного кода
 * (ECONNREFUSED / TLS / abort), которую «Connection error.» обычно скрывает.
 */
export function describeAiFailure(err: unknown): string {
  const e = err as { status?: unknown; error?: unknown; headers?: unknown };
  const parts: string[] = [];
  if (typeof e.status === 'number') parts.push(`HTTP ${e.status}`);
  const requestId = requestIdOf(e.headers);
  if (requestId) parts.push(`x-request-id: ${requestId}`);
  if (e.error !== undefined && e.error !== null) {
    try {
      parts.push(`тело ответа: ${shortenText(JSON.stringify(e.error), BODY_PREVIEW_CHARS)}`);
    } catch {
      /* circular body — the cause chain below still describes the failure */
    }
  }
  parts.push(`ошибка: ${causeChain(err).join(' ← ') || String(err)}`);
  return parts.join(' | ');
}
