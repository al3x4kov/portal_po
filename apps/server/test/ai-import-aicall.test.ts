import { describe, expect, it, vi } from 'vitest';
import {
  AI_BACKOFF_CAP_MS,
  AI_UPSTREAM_MAX_ATTEMPTS,
  PerCallTimeoutError,
  backoffDelayMs,
  callAiWithRetries,
  classifyAiError,
  retryAfterMs,
} from '../src/services/aiImport/aiCall.js';

/*
 * todo_20 · T-209: обёртка AI-вызова (П4, пилотный баг №3).
 * Классификация 429/5xx/сеть/таймаут/401/403/404/context_length; ретраи с
 * экспоненциальным backoff + джиттер + Retry-After; per-call timeout.
 */

function httpError(status: number, message = `HTTP ${status}`, headers?: Record<string, string>) {
  const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

function codeError(code: string, message = code) {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('T-209 · classifyAiError', () => {
  it('429 → rate-limit', () => {
    expect(classifyAiError(httpError(429))).toBe('rate-limit');
  });

  it('5xx → server', () => {
    expect(classifyAiError(httpError(500))).toBe('server');
    expect(classifyAiError(httpError(503))).toBe('server');
  });

  it('401/403 → auth (не ретраится)', () => {
    expect(classifyAiError(httpError(401))).toBe('auth');
    expect(classifyAiError(httpError(403))).toBe('auth');
  });

  it('404 → model-not-found', () => {
    expect(classifyAiError(httpError(404, 'model not found'))).toBe('model-not-found');
  });

  it('400 context_length → context-length (сигнал чанкеру, не ретрай)', () => {
    expect(
      classifyAiError(httpError(400, "This model's maximum context length is 8192 tokens")),
    ).toBe('context-length');
    expect(classifyAiError(httpError(400, 'context_length_exceeded'))).toBe('context-length');
  });

  it('прочий 400 → bad-request', () => {
    expect(classifyAiError(httpError(400, 'invalid parameter'))).toBe('bad-request');
  });

  it('сетевые коды → network (в т.ч. в цепочке cause)', () => {
    expect(classifyAiError(codeError('ECONNREFUSED'))).toBe('network');
    expect(classifyAiError(codeError('ENOTFOUND'))).toBe('network');
    const wrapped = new Error('Connection error.');
    (wrapped as Error & { cause?: unknown }).cause = codeError('ECONNRESET');
    expect(classifyAiError(wrapped)).toBe('network');
  });

  it('таймауты → timeout', () => {
    expect(classifyAiError(new PerCallTimeoutError(120_000))).toBe('timeout');
    expect(classifyAiError(codeError('ETIMEDOUT'))).toBe('timeout');
    expect(classifyAiError(new Error('Request timed out'))).toBe('timeout');
  });

  it('неизвестная ошибка → unknown (фейлит без ретраев — прежнее поведение)', () => {
    expect(classifyAiError(new Error('hub down'))).toBe('unknown');
  });
});

describe('T-209 · retryAfterMs / backoffDelayMs', () => {
  it('уважает Retry-After в секундах', () => {
    expect(retryAfterMs(httpError(429, 'x', { 'retry-after': '3' }))).toBe(3000);
  });

  it('без заголовка — undefined', () => {
    expect(retryAfterMs(httpError(429))).toBeUndefined();
  });

  it('backoff растёт экспоненциально 1s→2s→4s→8s и капится', () => {
    const noJitter = () => 0;
    expect(backoffDelayMs(1, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, noJitter)).toBe(4000);
    expect(backoffDelayMs(4, noJitter)).toBe(8000);
    expect(backoffDelayMs(5, noJitter)).toBe(AI_BACKOFF_CAP_MS);
  });

  it('джиттер добавляется от random', () => {
    expect(backoffDelayMs(1, () => 1)).toBeGreaterThan(1000);
  });
});

describe('T-209 · callAiWithRetries', () => {
  const instantSleep = async () => {};

  it('успех с первой попытки', async () => {
    const res = await callAiWithRetries({
      call: async () => 'ok',
      timeoutMs: 1000,
      sleep: instantSleep,
    });
    expect(res).toEqual({ ok: true, value: 'ok', attempts: 1 });
  });

  it('429 → ретраи с backoff, затем успех (без действий пользователя)', async () => {
    let calls = 0;
    const delays: number[] = [];
    const res = await callAiWithRetries({
      call: async () => {
        calls += 1;
        if (calls < 3) throw httpError(429);
        return 'ok';
      },
      timeoutMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('Retry-After важнее расчётного backoff', async () => {
    let calls = 0;
    const delays: number[] = [];
    await callAiWithRetries({
      call: async () => {
        calls += 1;
        if (calls === 1) throw httpError(429, 'x', { 'retry-after': '5' });
        return 'ok';
      },
      timeoutMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });
    expect(delays).toEqual([5000]);
  });

  it('постоянный 5xx исчерпывает попытки → ok:false server c числом попыток', async () => {
    let calls = 0;
    const res = await callAiWithRetries({
      call: async () => {
        calls += 1;
        throw httpError(502);
      },
      timeoutMs: 1000,
      sleep: instantSleep,
      random: () => 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorClass).toBe('server');
      expect(res.attempts).toBe(AI_UPSTREAM_MAX_ATTEMPTS);
    }
    expect(calls).toBe(AI_UPSTREAM_MAX_ATTEMPTS);
  });

  it('401 → немедленный fail без ретраев', async () => {
    let calls = 0;
    const res = await callAiWithRetries({
      call: async () => {
        calls += 1;
        throw httpError(401);
      },
      timeoutMs: 1000,
      sleep: instantSleep,
    });
    expect(res).toMatchObject({ ok: false, errorClass: 'auth', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('context_length → немедленный сигнал (не ретраится)', async () => {
    let calls = 0;
    const res = await callAiWithRetries({
      call: async () => {
        calls += 1;
        throw httpError(400, 'maximum context length exceeded');
      },
      timeoutMs: 1000,
      sleep: instantSleep,
    });
    expect(res).toMatchObject({ ok: false, errorClass: 'context-length', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('unknown → немедленный fail (прежнее поведение сохранено)', async () => {
    const res = await callAiWithRetries({
      call: async () => {
        throw new Error('hub down');
      },
      timeoutMs: 1000,
      sleep: instantSleep,
    });
    expect(res).toMatchObject({ ok: false, errorClass: 'unknown', attempts: 1 });
  });

  it('зависший вызов обрывается по тайм-ауту и уходит в ретрай (пилот-3)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = callAiWithRetries({
        call: (signal) => {
          calls += 1;
          if (calls === 1) {
            // «Зависший» запрос: резолвится только по abort.
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
          }
          return Promise.resolve('ok');
        },
        timeoutMs: 50,
        sleep: async () => {},
        random: () => 0,
      });
      await vi.advanceTimersByTimeAsync(60);
      const res = await promise;
      expect(res).toEqual({ ok: true, value: 'ok', attempts: 2 });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('диагностика onRetry: класс ошибки, попытка, задержка', async () => {
    const diags: Array<{ attempt: number; errorClass: string; waitMs: number }> = [];
    let calls = 0;
    await callAiWithRetries({
      call: async () => {
        calls += 1;
        if (calls === 1) throw httpError(503);
        return 'ok';
      },
      timeoutMs: 1000,
      sleep: instantSleep,
      random: () => 0,
      onRetry: (d) =>
        diags.push({ attempt: d.attempt, errorClass: d.errorClass, waitMs: d.waitMs }),
    });
    expect(diags).toEqual([{ attempt: 1, errorClass: 'server', waitMs: 1000 }]);
  });

  it('«500 вызовов, 5% сбоят» (мок) — завершается без действий пользователя (приёмка №2)', async () => {
    let failures = 0;
    for (let i = 0; i < 500; i++) {
      let attemptsForCall = 0;
      const res = await callAiWithRetries({
        call: async () => {
          attemptsForCall += 1;
          // 5% вызовов сбоят на первой попытке (429/500/таймаут по кругу).
          if (i % 20 === 0 && attemptsForCall === 1) {
            const kind = i % 3;
            if (kind === 0) throw httpError(429);
            if (kind === 1) throw httpError(500);
            throw codeError('ETIMEDOUT');
          }
          return `ok-${i}`;
        },
        timeoutMs: 1000,
        sleep: instantSleep,
        random: () => 0,
      });
      if (!res.ok) failures += 1;
    }
    expect(failures).toBe(0);
  });

  it('shouldStop прерывает ретраи между попытками (cancel)', async () => {
    let calls = 0;
    const res = await callAiWithRetries({
      call: async () => {
        calls += 1;
        throw httpError(429);
      },
      timeoutMs: 1000,
      sleep: instantSleep,
      random: () => 0,
      shouldStop: () => calls >= 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorClass).toBe('cancelled');
    expect(calls).toBe(2);
  });
});
