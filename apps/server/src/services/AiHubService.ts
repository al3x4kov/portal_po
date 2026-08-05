import {
  AI_CHAT_MAX_TOKENS,
  AI_CHAT_TEMPERATURE,
  AI_GEN_MAX_TOKENS,
  AI_GEN_TEMPERATURE,
  AI_TESTGEN_TEMPERATURE,
  aiTestCaseSchema,
  resolveModelPreset,
  testGenFittingBatch,
  testGenMaxTokens,
  type AiChatRequest,
  type AiGenerateTestsRequest,
  type AiGenerateTestsResponse,
  type AiModelPreset,
  type GenerateDescriptionRequest,
  type Requirement,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import { AiUpstreamError, BadRequestError } from '../lib/errors.js';
import { assertChatCapableModel } from '../lib/embeddingGuard.js';
import type { OpLogger } from '../lib/logger.js';
import {
  buildChatMessages,
  buildDescriptionMessages,
  buildTestCasesMessages,
  type AiChatMessage,
  type TestGenRequirementInfo,
} from './aiPrompt.js';
import { extractJsonArray } from './aiImportPrompt.js';
import { callAiWithRetries } from './aiImport/aiCall.js';
import {
  buildTestGenResponseFormat,
  isResponseFormatRejection,
} from './aiImport/structuredOutput.js';
import { stripReasoning } from './aiReasoning.js';
import { sanitize } from '../lib/redact.js';

/** Parameters passed to a chat completion (subset we rely on). */
export interface AiChatCompletionParams {
  model: string;
  messages: AiChatMessage[];
  temperature: number;
  max_tokens: number;
  /** Nucleus sampling — sent only when the effective model preset defines it (todo_18). */
  top_p?: number;
  /** todo_20 T-206: structured output (json_schema/json_object) with per-run fallback. */
  response_format?: Record<string, unknown>;
}

/** Per-request options (todo_20 T-209: per-call timeout via AbortController). */
export interface AiChatCompletionOptions {
  signal?: AbortSignal;
  /** Per-request timeout, ms (the OpenAI SDK honours it per call). */
  timeout?: number;
}

/** Minimal OpenAI-compatible client surface used by the service. */
export interface AiClient {
  models: {
    list(): Promise<{ data: Array<{ id: string }> }>;
  };
  chat: {
    completions: {
      create(
        params: AiChatCompletionParams,
        options?: AiChatCompletionOptions,
      ): Promise<{
        choices: Array<{
          message: { content: string | null };
          /** OpenAI finish reason; `'length'` = answer truncated by max_tokens (Task 14 B2). */
          finish_reason?: string | null;
        }>;
        /** todo_20 T-208/C4: token usage of the answer (accumulated per run). */
        usage?: {
          prompt_tokens?: number | null;
          completion_tokens?: number | null;
        } | null;
      }>;
    };
  };
}

/**
 * Factory building a client bound to a key+baseURL. Injected so tests supply a
 * mock and production supplies the real `openai` wrapper. The baseURL always
 * comes from the stored config (important for the e2e stub), never hard-coded.
 */
export type AiClientFactory = (apiKey: string, baseURL: string) => AiClient;

export interface AiHubServiceDeps {
  repo: AiConfigRepo;
  makeClient: AiClientFactory;
  log?: OpLogger;
}

/**
 * Flatten an error and its `cause` chain into one readable line. The `openai`
 * SDK reports transport failures as a generic "Connection error.", hiding the
 * real reason (e.g. a TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `ECONNREFUSED`)
 * one or two `cause` levels down — so we surface the whole chain.
 */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur != null && i < 6; i++) {
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
    const msg = typeof e.message === 'string' && e.message ? e.message : String(cur);
    const code = e.code ? ` (${String(e.code)})` : '';
    const line = `${msg}${code}`;
    if (parts[parts.length - 1] !== line) parts.push(line);
    cur = e.cause;
  }
  return parts.join(' ← ');
}

/**
 * Use-case service for AI Hub: reads the stored config, builds an OpenAI-style
 * client via the injected factory, and exposes model listing + description
 * generation. Missing key/model → {@link BadRequestError} (400); any upstream
 * failure → {@link AiUpstreamError} (502) with a key-free message.
 */
export class AiHubService {
  private readonly repo: AiConfigRepo;
  private readonly makeClient: AiClientFactory;

  constructor(deps: AiHubServiceDeps) {
    this.repo = deps.repo;
    this.makeClient = deps.makeClient;
  }

  /** List available model ids (sorted, de-duplicated). Requires a stored key. */
  async listModels(): Promise<string[]> {
    const cfg = await this.repo.read();
    if (!cfg.apiKey) {
      throw new BadRequestError('AI Hub API key is not configured.');
    }
    const client = this.makeClient(cfg.apiKey, cfg.baseURL);
    let data: Array<{ id: string }>;
    try {
      const res = await client.models.list();
      data = res.data ?? [];
    } catch (err) {
      throw new AiUpstreamError(
        sanitize(`Failed to load models from AI Hub: ${describeError(err)}`, cfg.apiKey),
      );
    }
    const ids = new Set<string>();
    for (const m of data) if (m && typeof m.id === 'string' && m.id) ids.add(m.id);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Generate a requirement description. Requires a stored key AND a per-project
   * model. Returns the trimmed model output.
   */
  async generateDescription(input: GenerateDescriptionRequest): Promise<string> {
    const cfg = await this.repo.read();
    if (!cfg.apiKey) {
      throw new BadRequestError('AI Hub API key is not configured.');
    }
    const model = cfg.modelByProject[input.projectId];
    if (!model) {
      throw new BadRequestError('No AI model is selected for this project.');
    }
    assertChatCapableModel(model); // embedding-модель не умеет chat completions → 400

    const client = this.makeClient(cfg.apiKey, cfg.baseURL);
    const messages = buildDescriptionMessages(input);
    // todo_18: keep the generation-specific temperature, but clamp the token
    // budget to the model preset and honour its reasoning/topP.
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);

    let content: string | null;
    try {
      const res = await client.chat.completions.create({
        model,
        messages,
        temperature: AI_GEN_TEMPERATURE,
        max_tokens: Math.min(AI_GEN_MAX_TOKENS, preset.maxOutputTokens),
        ...(preset.topP !== undefined ? { top_p: preset.topP } : {}),
      });
      content = res.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      throw new AiUpstreamError(
        sanitize(`AI Hub generation failed: ${describeError(err)}`, cfg.apiKey),
      );
    }

    const text = this.cleanAnswer(content, preset);
    if (!text) {
      throw new AiUpstreamError('AI Hub returned an empty description.');
    }
    return text;
  }

  /**
   * Answer one chat-widget turn (Task 9). Requires a stored key; the model is
   * the request override, else the per-project model of `input.projectId`,
   * else 400. Returns the trimmed assistant reply.
   */
  async chat(input: AiChatRequest): Promise<string> {
    const cfg = await this.repo.read();
    if (!cfg.apiKey) {
      throw new BadRequestError('AI Hub API key is not configured.');
    }
    const model =
      input.model ?? (input.projectId ? cfg.modelByProject[input.projectId] : undefined);
    if (!model) {
      throw new BadRequestError(
        'No AI model is selected. Choose a model in the chat or configure the project.',
      );
    }
    assertChatCapableModel(model); // embedding-модель не умеет chat completions → 400

    const client = this.makeClient(cfg.apiKey, cfg.baseURL);
    const messages = buildChatMessages(input);
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);

    let content: string | null;
    try {
      const res = await client.chat.completions.create({
        model,
        messages,
        temperature: AI_CHAT_TEMPERATURE,
        max_tokens: Math.min(AI_CHAT_MAX_TOKENS, preset.maxOutputTokens),
        ...(preset.topP !== undefined ? { top_p: preset.topP } : {}),
      });
      content = res.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      throw new AiUpstreamError(sanitize(`AI Hub chat failed: ${describeError(err)}`, cfg.apiKey));
    }

    const text = this.cleanAnswer(content, preset);
    if (!text) {
      throw new AiUpstreamError('AI Hub returned an empty chat response.');
    }
    return text;
  }

  /**
   * Тест-генерация (развилка «Генерации артефактов»): батч выбранных требований
   * → тест-кейсы + детерминированная анти-галлюцинационная проверка.
   *
   * Надёжность построена по схеме AI-импорта документации, потому что прежняя
   * («один вызов, фиксированный бюджет 3000 токенов, ноль повторов») роняла
   * ПЕРВЫЙ же батч: ответ на 10 кейсов с негативом не помещался в лимит и
   * обрывался на середине JSON. Теперь:
   *
   * 1. бюджет ответа считается от размера батча ({@link testGenMaxTokens}) и
   *    клампится пресетом модели;
   * 2. батч, который заведомо не помещается в бюджет модели, режется на части
   *    ЕЩЁ ДО обращения к хабу ({@link testGenFittingBatch});
   * 3. каждый вызов идёт через {@link callAiWithRetries}: 429/5xx/сеть/таймаут
   *    повторяются с backoff под per-call таймаутом пресета;
   * 4. часть, которая всё равно не далась (обрыв по контексту, нераспознанный
   *    JSON), делится пополам и повторяется — вплоть до одного требования;
   * 5. итог всегда частичный, а не «всё пропало»: удавшиеся кейсы возвращаются,
   *    неудавшиеся требования уходят в `missing` и достраиваются шаблоном.
   *
   * Правила проверки (якорь — slug требования из ЭТОГО батча):
   * - кейс с чужим/выдуманным slug'ом отбрасывается;
   * - второй кейс на тот же slug отбрасывается (первый побеждает);
   * - невалидная форма кейса отбрасывается;
   * - требования без кейса возвращаются списком `missing`.
   *
   * `requirements` — батч, уже загруженный роутом из проекта (источник истины);
   * `nameBySlug` — полный словарь имён проекта для контекста детей в промпте.
   */
  async generateTestCases(
    input: AiGenerateTestsRequest,
    requirements: Requirement[],
    nameBySlug: ReadonlyMap<string, string>,
  ): Promise<AiGenerateTestsResponse> {
    const cfg = await this.repo.read();
    if (!cfg.apiKey) {
      throw new BadRequestError('AI Hub API key is not configured.');
    }
    const model = input.model ?? cfg.modelByProject[input.projectId];
    if (!model) {
      throw new BadRequestError('No AI model is selected for this project.');
    }
    assertChatCapableModel(model);

    const negatives = input.kind === 'smoke' ? (input.negatives ?? false) : true;
    const preset = resolveModelPreset(model, cfg.modelPresets?.[model]);
    const client = this.makeClient(cfg.apiKey, cfg.baseURL);
    const infoOf = (r: Requirement): TestGenRequirementInfo => ({
      slug: r.slug,
      type: r.type,
      criticality: r.criticality,
      name: r.name,
      ...(r.description !== undefined ? { description: r.description } : {}),
      childNames: r.links
        .filter((l) => l.type === 'PARENT_OF')
        .map((l) => nameBySlug.get(l.targetSlug))
        .filter((n): n is string => n !== undefined),
    });

    const bySlug = new Map<string, (typeof aiTestCaseSchema)['_output']>();
    let dropped = 0;
    /** Первая непреодолимая ошибка — поднимается только если НИЧЕГО не вышло. */
    let fatal: Error | null = null;

    /**
     * Обработать одну часть батча. Неуспех — не исключение, а `false`: часть
     * делится пополам и повторяется, пока в ней больше одного требования.
     */
    const runPart = async (part: Requirement[]): Promise<boolean> => {
      const allowed = new Set(part.map((r) => r.slug));
      const params = {
        model,
        messages: buildTestCasesMessages(input.kind, part.map(infoOf), negatives),
        temperature: AI_TESTGEN_TEMPERATURE,
        max_tokens: Math.min(testGenMaxTokens(part.length, negatives), preset.maxOutputTokens),
        ...(preset.topP !== undefined ? { top_p: preset.topP } : {}),
      };

      const ask = (withFormat: boolean) =>
        callAiWithRetries({
          call: () =>
            client.chat.completions.create(
              withFormat ? { ...params, response_format: buildTestGenResponseFormat() } : params,
            ),
          timeoutMs: preset.perCallTimeoutSec * 1000,
        });

      let result = await ask(true);
      if (!result.ok && isResponseFormatRejection(result.error)) {
        // Бэкенд без structured output (vLLM/Ollama/прокси) — повтор без схемы.
        result = await ask(false);
      }
      if (!result.ok) {
        // Причина сохраняется, чтобы поднять её, если НИ ОДНА часть не далась.
        fatal ??= new AiUpstreamError(
          sanitize(
            `AI Hub test generation failed: ${describeError(result.error)}`,
            cfg.apiKey ?? '',
          ),
        );
        return false;
      }

      const content = result.value.choices?.[0]?.message?.content ?? null;
      const array = extractJsonArray(this.cleanAnswer(content, preset));
      if (array === null) return false; // обрыв ответа/не JSON — дробим часть

      for (const raw of array) {
        // strict json_schema выражает опциональность null'ами — нормализуем.
        const candidate =
          typeof raw === 'object' && raw !== null
            ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null))
            : raw;
        const parsed = aiTestCaseSchema.safeParse(candidate);
        if (!parsed.success || !allowed.has(parsed.data.slug) || bySlug.has(parsed.data.slug)) {
          dropped += 1;
          continue;
        }
        bySlug.set(parsed.data.slug, parsed.data);
      }
      return true;
    };

    /** Пройти часть, при неуспехе — половинками, вплоть до одного требования. */
    const runAdaptive = async (part: Requirement[]): Promise<void> => {
      if (part.length === 0) return;
      if (await runPart(part)) return;
      if (part.length === 1) return; // одиночное требование — уйдёт в missing
      const mid = Math.ceil(part.length / 2);
      await runAdaptive(part.slice(0, mid));
      await runAdaptive(part.slice(mid));
    };

    // Батч, заведомо не помещающийся в бюджет модели, режем ДО первого вызова.
    const fitting = Math.min(
      requirements.length,
      testGenFittingBatch(preset.maxOutputTokens, negatives),
    );
    for (let i = 0; i < requirements.length; i += fitting) {
      await runAdaptive(requirements.slice(i, i + fitting));
    }

    const missing = requirements.map((r) => r.slug).filter((s) => !bySlug.has(s));
    // Полный провал батча — это ошибка вызова; частичный успех ошибкой не считаем.
    if (bySlug.size === 0 && fatal !== null) throw fatal;
    if (bySlug.size === 0 && requirements.length > 0) {
      throw new AiUpstreamError(
        'Ответ модели не распознан как JSON-массив тест-кейсов — повторите генерацию.',
      );
    }
    return { cases: [...bySlug.values()], dropped, missing };
  }

  /**
   * Post-process a model answer per the effective preset: strip
   * `<think>…</think>` reasoning wrappers when `reasoning === 'strip'` (todo_18),
   * then trim. `reasoning === 'none'` returns the answer verbatim (Coder-Next).
   */
  private cleanAnswer(content: string | null, preset: AiModelPreset): string {
    const raw = content ?? '';
    return (preset.reasoning === 'strip' ? stripReasoning(raw) : raw).trim();
  }
}
