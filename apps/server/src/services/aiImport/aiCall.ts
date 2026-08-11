/**
 * todo_20 · T-209: resilient AI-call wrapper (spec П4, пилотный баг №3).
 *
 * One place classifies every upstream failure and decides its fate:
 *
 * - `429 / 5xx / network / timeout` — transient: retried with exponential
 *   backoff (1s→2s→4s→8s cap) + jitter, honouring `Retry-After`;
 * - `400 context_length` — a signal for the adaptive chunker, never retried;
 * - `401/403` (CFG-02), `404 model` (CFG-03), other `400` and unknown errors
 *   — fail fast (the historical behaviour for unclassifiable errors).
 *
 * Every call runs under a per-call timeout ({@link PerCallTimeoutError}) driven
 * by `preset.perCallTimeoutSec` — a hung request aborts and re-enters the
 * retry loop, so «Timeout» is never a silent hang again.
 */

/** Max attempts for one logical call (архитектурное допущение T-209: N=6). */
export const AI_UPSTREAM_MAX_ATTEMPTS = 6;
/** First backoff step, ms. */
export const AI_BACKOFF_BASE_MS = 1000;
/** Backoff cap, ms (1s→2s→4s→8s). */
export const AI_BACKOFF_CAP_MS = 8000;
/** Max jitter added to each backoff step, ms. */
export const AI_BACKOFF_JITTER_MS = 250;
/**
 * todo_23 · M4: backoff window after a per-call timeout. A timed-out upstream
 * is overloaded — retrying after ~1s almost always burns another full per-call
 * timeout (пилотный лог: 19 повторов × 120с). The retry waits 15–30s instead;
 * the per-call timeout itself is NOT changed.
 */
export const AI_TIMEOUT_BACKOFF_MIN_MS = 15_000;
export const AI_TIMEOUT_BACKOFF_MAX_MS = 30_000;

/** Failure classes of one AI call. */
export type AiCallErrorClass =
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'model-not-found'
  | 'context-length'
  | 'bad-request'
  | 'cancelled'
  | 'unknown';

/** Classes the wrapper retries with backoff. */
const RETRIABLE = new Set<AiCallErrorClass>(['rate-limit', 'server', 'network', 'timeout']);

/** Raised when a call exceeds the per-call timeout. */
export class PerCallTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`AI call timed out after ${waitedMs} ms`);
    this.name = 'PerCallTimeoutError';
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const CONTEXT_LENGTH_RE =
  /context.?length|maximum context|context window|too many tokens|maximum.{0,20}tokens/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;
const CONNECTION_RE = /connection error|fetch failed|socket hang ?up|network/i;

/** Walk the `cause` chain collecting codes/messages (SDK wraps transport errors). */
function chain(err: unknown): Array<{ code?: string; message: string; name?: string }> {
  const out: Array<{ code?: string; message: string; name?: string }> = [];
  let cur: unknown = err;
  for (let i = 0; cur != null && i < 6; i++) {
    const e = cur as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    out.push({
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : String(cur),
      name: typeof e.name === 'string' ? e.name : undefined,
    });
    cur = e.cause;
  }
  return out;
}

/** Classify one upstream error (see the module doc for the taxonomy). */
export function classifyAiError(err: unknown): AiCallErrorClass {
  if (err instanceof PerCallTimeoutError) return 'timeout';

  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'model-not-found';
    if (status === 400 || status === 413) {
      const message = (err as Error).message ?? '';
      return CONTEXT_LENGTH_RE.test(message) ? 'context-length' : 'bad-request';
    }
  }

  const links = chain(err);
  if (
    links.some(
      (l) => (l.code && TIMEOUT_CODES.has(l.code)) || l.name === 'APIConnectionTimeoutError',
    )
  )
    return 'timeout';
  if (links.some((l) => l.code && NETWORK_CODES.has(l.code))) return 'network';
  if (links.some((l) => TIMEOUT_RE.test(l.message))) return 'timeout';
  if (links.some((l) => l.name === 'APIConnectionError' || CONNECTION_RE.test(l.message)))
    return 'network';
  return 'unknown';
}

/** `Retry-After` of a 429/5xx response in ms, when the API provides it. */
export function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const raw =
    (headers as Record<string, unknown>)['retry-after'] ??
    (headers as { get?: (k: string) => unknown }).get?.('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Exponential backoff with jitter: min(1s·2^(n-1), 8s) + random·250ms. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(AI_BACKOFF_BASE_MS * 2 ** (attempt - 1), AI_BACKOFF_CAP_MS);
  return base + Math.round(random() * AI_BACKOFF_JITTER_MS);
}

/** todo_23 M4: backoff after a per-call timeout — random 15–30s (module doc). */
export function timeoutBackoffMs(random: () => number = Math.random): number {
  return (
    AI_TIMEOUT_BACKOFF_MIN_MS +
    Math.round(random() * (AI_TIMEOUT_BACKOFF_MAX_MS - AI_TIMEOUT_BACKOFF_MIN_MS))
  );
}

/** Diagnostics of one retry decision (goes to the human-readable log). */
export interface AiRetryDiagnostics {
  /** 1-based attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  errorClass: AiCallErrorClass;
  /** Delay before the next attempt, ms. */
  waitMs: number;
  /** Short raw detail for the log (sanitized by the caller). */
  detail: string;
}

export interface CallAiOptions<T> {
  /** The actual transport call; must observe `signal` for the timeout to bite. */
  call: (signal: AbortSignal) => Promise<T>;
  /** Per-call timeout, ms (`preset.perCallTimeoutSec * 1000`). */
  timeoutMs: number;
  maxAttempts?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each backoff sleep — the caller logs it in Russian. */
  onRetry?: (diag: AiRetryDiagnostics) => void;
  /** Cancel check between attempts (job cancel). */
  shouldStop?: () => boolean;
  /**
   * «Задержка при отправке запросов» (глобальная настройка AI): принудительная
   * пауза, мс, ПОСЛЕ каждого фактического запроса к AI Hub. Выполняется ВНЕ
   * per-call тайм-аута (та не съедает бюджет ответа): после успешного ответа и
   * после финальной ошибки — перед возвратом результата; ожидание между
   * повторными попытками не короче этой задержки.
   */
  delayAfterAttemptMs?: number;
}

export type CallAiResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; errorClass: AiCallErrorClass; error: Error; attempts: number };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run one call under the per-call timeout. */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject FIRST: abort() may synchronously reject the underlying call
      // with a generic AbortError, and the race must surface OUR timeout.
      reject(new PerCallTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute one logical AI call with classification + retries (module doc).
 * Never throws: the outcome is a discriminated union the pipeline maps onto
 * error codes (NET-01/02/03, CFG-02/03) or chunker signals (context-length).
 */
export async function callAiWithRetries<T>(opts: CallAiOptions<T>): Promise<CallAiResult<T>> {
  const maxAttempts = opts.maxAttempts ?? AI_UPSTREAM_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const delayMs = opts.delayAfterAttemptMs ?? 0;

  let lastError: Error = new Error('AI call was not attempted');
  let lastClass: AiCallErrorClass = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await withTimeout(opts.call, opts.timeoutMs);
      // Принудительная «Задержка при отправке запросов» — после КАЖДОГО
      // запроса, в т.ч. успешного (следующий уйдёт не раньше паузы).
      if (delayMs > 0) await sleep(delayMs);
      return { ok: true, value, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      lastClass = classifyAiError(err);
      if (!RETRIABLE.has(lastClass) || attempt === maxAttempts) {
        if (delayMs > 0) await sleep(delayMs);
        return { ok: false, errorClass: lastClass, error: lastError, attempts: attempt };
      }
      if (opts.shouldStop?.()) {
        return { ok: false, errorClass: 'cancelled', error: lastError, attempts: attempt };
      }
      // todo_23 M4: a timeout waits 15–30s (give the upstream time to recover
      // instead of instantly burning another full per-call timeout).
      // Межпопыточное ожидание не короче «Задержки при отправке запросов».
      const waitMs = Math.max(
        delayMs,
        retryAfterMs(err) ??
          (lastClass === 'timeout' ? timeoutBackoffMs(random) : backoffDelayMs(attempt, random)),
      );
      opts.onRetry?.({
        attempt,
        maxAttempts,
        errorClass: lastClass,
        waitMs,
        detail: lastError.message,
      });
      await sleep(waitMs);
      if (opts.shouldStop?.()) {
        return { ok: false, errorClass: 'cancelled', error: lastError, attempts: attempt };
      }
    }
  }
  return { ok: false, errorClass: lastClass, error: lastError, attempts: maxAttempts };
}
