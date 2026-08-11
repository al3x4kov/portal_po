import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';
import type { AiClient, AiClientFactory } from './AiHubService.js';

/**
 * Build an undici {@link Dispatcher} for the AI Hub client from environment, or
 * `undefined` to use Node's default fetch. This is scoped to the AI Hub client
 * only — it never changes global TLS behaviour.
 *
 * - `AI_HUB_CA_CERT` — path to a PEM CA bundle to additionally trust. Use this
 *   when AI Hub sits behind a corporate/internal root CA that Node does not ship
 *   (the secure fix: `curl` works because the OS trusts that CA, Node does not).
 * - `AI_HUB_INSECURE_TLS` — TLS verification for AI Hub. **Defaults to disabled**
 *   (verification OFF) so the app works behind an internal CA out of the box; this
 *   is scoped to AI Hub only, never the global `NODE_TLS_REJECT_UNAUTHORIZED=0`.
 *   Set `AI_HUB_INSECURE_TLS=0` (or provide `AI_HUB_CA_CERT`) to enforce verification.
 * - `AI_HUB_PROXY` — принудительный прокси ТОЛЬКО для AI Hub (явная настройка
 *   продукта, `NO_PROXY` к ней не применяется).
 * - `HTTPS_PROXY` из окружения — стандартная семантика: применяется с учётом
 *   `NO_PROXY`/`no_proxy`. Раньше NO_PROXY игнорировался, и хаб на
 *   `127.0.0.1`/`localhost` (Ollama, vLLM, e2e-стаб) за корпоративным прокси
 *   становился недостижим — запросы к нему насильно уходили в прокси.
 */
export function buildAiDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
  const caPath = env.AI_HUB_CA_CERT?.trim();
  const forcedProxy = (env.AI_HUB_PROXY ?? '').trim();
  const envProxy = (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();
  // Default to insecure (verification off) unless a CA is supplied or the user
  // explicitly opts out with AI_HUB_INSECURE_TLS=0 — AI Hub usually sits behind an
  // internal CA that Node doesn't ship, so this keeps it working out of the box.
  const insecure =
    env.AI_HUB_INSECURE_TLS !== undefined
      ? env.AI_HUB_INSECURE_TLS === '1' || env.AI_HUB_INSECURE_TLS === 'true'
      : !caPath;

  const connect: { ca?: string; rejectUnauthorized?: boolean } = {};
  if (caPath) connect.ca = readFileSync(caPath, 'utf8');
  if (insecure) connect.rejectUnauthorized = false;
  const hasConnect = Object.keys(connect).length > 0;

  if (forcedProxy) {
    return new ProxyAgent(hasConnect ? { uri: forcedProxy, connect } : { uri: forcedProxy });
  }
  if (envProxy) {
    return new EnvHttpProxyAgent({
      httpProxy: envProxy,
      httpsProxy: envProxy,
      noProxy: (env.NO_PROXY ?? env.no_proxy ?? '').trim(),
      ...(hasConnect ? { connect } : {}),
    });
  }
  if (hasConnect) return new Agent({ connect });
  return undefined;
}

/**
 * Per-attempt timeout for one AI Hub HTTP request, in milliseconds.
 *
 * The `openai` SDK default is 600 000 ms (10 minutes), so a hung AI Hub used to
 * stall chat / description generation / AI import for minutes. 40 s comfortably
 * covers a slow chat completion (the heaviest call we make, ≤ AI_*_MAX_TOKENS)
 * while keeping the worst case bounded: with {@link AI_HUB_MAX_RETRIES} = 1 the
 * total wait for one call is ≤ ~80 s (2 attempts × 40 s + sub-second backoff),
 * within the ≤ 90 s budget.
 */
export const AI_HUB_TIMEOUT_MS = 40_000;

/**
 * Retry budget for one AI Hub call (SDK default is 2). One retry keeps the
 * resilience to transient 5xx/connection errors but halves the worst-case wait
 * versus the default: total ≤ (1 + 1) × {@link AI_HUB_TIMEOUT_MS} ≈ 80 s.
 */
export const AI_HUB_MAX_RETRIES = 1;

/**
 * Production {@link AiClientFactory}: wraps the real `openai` SDK. The AI Hub is
 * OpenAI-compatible, so `models.list()` and `chat.completions.create()` map
 * directly. The `baseURL` is supplied by the caller (from the stored config),
 * which is what lets the e2e stub point the client at a local server.
 *
 * When a dispatcher is configured (CA / insecure / proxy — see
 * {@link buildAiDispatcher}) the client uses undici's own `fetch` bound to that
 * dispatcher, so the settings apply to AI Hub calls only. Using undici's own
 * `fetch` (not Node's global one) avoids a cross-instance dispatcher mismatch.
 */
export function createOpenAiClientFactory(env: NodeJS.ProcessEnv = process.env): AiClientFactory {
  const dispatcher = buildAiDispatcher(env);
  const fetchImpl = dispatcher
    ? (((input: unknown, init?: Record<string, unknown>) =>
        undiciFetch(input as string, { ...(init ?? {}), dispatcher })) as unknown as typeof fetch)
    : undefined;

  return (apiKey: string, baseURL: string): AiClient => {
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: AI_HUB_TIMEOUT_MS,
      maxRetries: AI_HUB_MAX_RETRIES,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    // The SDK's shape is a structural superset of our minimal AiClient port.
    return client as unknown as AiClient;
  };
}
