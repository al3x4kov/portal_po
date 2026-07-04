import { describe, expect, it } from 'vitest';
import {
  AI_HUB_MAX_RETRIES,
  AI_HUB_TIMEOUT_MS,
  createOpenAiClientFactory,
} from '../src/services/openaiClient.js';

describe('T-802 createOpenAiClientFactory', () => {
  it('builds an OpenAI-compatible client with the given key + baseURL', () => {
    const factory = createOpenAiClientFactory();
    // Construction is offline (no network call); it must expose the surface the
    // service relies on.
    const client = factory('sk-test', 'https://stub.test/v1');
    expect(typeof client.models.list).toBe('function');
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('passes an explicit timeout and maxRetries to the SDK (no 10-minute default)', () => {
    const factory = createOpenAiClientFactory();
    const client = factory('sk-test', 'https://stub.test/v1') as unknown as {
      timeout: number;
      maxRetries: number;
    };
    // A hung AI Hub must not stall a call for the SDK default (600 000 ms × 3 attempts).
    expect(client.timeout).toBe(AI_HUB_TIMEOUT_MS);
    expect(client.maxRetries).toBe(AI_HUB_MAX_RETRIES);
  });

  it('bounds the worst-case total wait of one call to ≤ 90 seconds', () => {
    // initial attempt + retries, ignoring the SDK's sub-second retry backoff
    const worstCaseMs = AI_HUB_TIMEOUT_MS * (1 + AI_HUB_MAX_RETRIES);
    expect(worstCaseMs).toBeLessThanOrEqual(90_000);
    expect(AI_HUB_MAX_RETRIES).toBeGreaterThanOrEqual(1); // keep one retry on 5xx
  });
});
