import OpenAI from 'openai';
import type { AiClient, AiClientFactory } from './AiHubService.js';

/**
 * Production {@link AiClientFactory}: wraps the real `openai` SDK. The AI Hub is
 * OpenAI-compatible, so `models.list()` and `chat.completions.create()` map
 * directly. The `baseURL` is supplied by the caller (from the stored config),
 * which is what lets the e2e stub point the client at a local server.
 */
export function createOpenAiClientFactory(): AiClientFactory {
  return (apiKey: string, baseURL: string): AiClient => {
    const client = new OpenAI({ apiKey, baseURL });
    // The SDK's shape is a structural superset of our minimal AiClient port.
    return client as unknown as AiClient;
  };
}
