import { describe, expect, it } from 'vitest';
import { createOpenAiClientFactory } from '../src/services/openaiClient.js';

describe('T-802 createOpenAiClientFactory', () => {
  it('builds an OpenAI-compatible client with the given key + baseURL', () => {
    const factory = createOpenAiClientFactory();
    // Construction is offline (no network call); it must expose the surface the
    // service relies on.
    const client = factory('sk-test', 'https://stub.test/v1');
    expect(typeof client.models.list).toBe('function');
    expect(typeof client.chat.completions.create).toBe('function');
  });
});
