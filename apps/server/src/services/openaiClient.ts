import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { AiClient, AiClientFactory } from './AiHubService.js';

/**
 * Build an undici {@link Dispatcher} for the AI Hub client from environment, or
 * `undefined` to use Node's default fetch. This is scoped to the AI Hub client
 * only — it never changes global TLS behaviour.
 *
 * - `AI_HUB_CA_CERT` — path to a PEM CA bundle to additionally trust. Use this
 *   when AI Hub sits behind a corporate/internal root CA that Node does not ship
 *   (the secure fix: `curl` works because the OS trusts that CA, Node does not).
 * - `AI_HUB_INSECURE_TLS=1` — disable TLS certificate verification for AI Hub
 *   requests ONLY (much narrower than the global `NODE_TLS_REJECT_UNAUTHORIZED=0`).
 *   Use only against a trusted internal host when the CA file is not available.
 * - `AI_HUB_PROXY` / `HTTPS_PROXY` — route AI Hub requests through an HTTP(S)
 *   proxy (Node's `fetch` ignores proxy env vars by default).
 */
export function buildAiDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
  const caPath = env.AI_HUB_CA_CERT?.trim();
  const insecure = env.AI_HUB_INSECURE_TLS === '1' || env.AI_HUB_INSECURE_TLS === 'true';
  const proxy = (env.AI_HUB_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();

  const connect: { ca?: string; rejectUnauthorized?: boolean } = {};
  if (caPath) connect.ca = readFileSync(caPath, 'utf8');
  if (insecure) connect.rejectUnauthorized = false;
  const hasConnect = Object.keys(connect).length > 0;

  if (proxy) return new ProxyAgent(hasConnect ? { uri: proxy, connect } : { uri: proxy });
  if (hasConnect) return new Agent({ connect });
  return undefined;
}

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
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    // The SDK's shape is a structural superset of our minimal AiClient port.
    return client as unknown as AiClient;
  };
}
