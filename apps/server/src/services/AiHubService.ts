import {
  AI_CHAT_MAX_TOKENS,
  AI_CHAT_TEMPERATURE,
  AI_GEN_MAX_TOKENS,
  AI_GEN_TEMPERATURE,
  resolveModelPreset,
  type AiChatRequest,
  type AiModelPreset,
  type GenerateDescriptionRequest,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import { AiUpstreamError, BadRequestError } from '../lib/errors.js';
import type { OpLogger } from '../lib/logger.js';
import { buildChatMessages, buildDescriptionMessages, type AiChatMessage } from './aiPrompt.js';
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
   * Post-process a model answer per the effective preset: strip
   * `<think>…</think>` reasoning wrappers when `reasoning === 'strip'` (todo_18),
   * then trim. `reasoning === 'none'` returns the answer verbatim (Coder-Next).
   */
  private cleanAnswer(content: string | null, preset: AiModelPreset): string {
    const raw = content ?? '';
    return (preset.reasoning === 'strip' ? stripReasoning(raw) : raw).trim();
  }
}
