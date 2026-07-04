import { createServer, type Server } from 'node:http';

/**
 * Shared OpenAI-compatible AI Hub stub for E2E (tasks 8 and 9).
 *
 * The real external AI Hub is unreachable from CI, but the app's AI client
 * always uses the `baseURL` from the SAVED config (`PUT /api/ai/config`) — an
 * `openai`-SDK wrapper does `GET <baseURL>/models` and
 * `POST <baseURL>/chat/completions`. So tests stand up this tiny HTTP stub on
 * 127.0.0.1 and point the config's Base URL at it. The app server runs as a
 * separate process on the same host, so it reaches the stub over loopback.
 *
 * Extras for task 9 (chat widget):
 * - every `/chat/completions` request body is captured (`chatRequests` /
 *   `lastChatRequest()`), so tests can assert the model override and the
 *   trailing-N history actually reach the upstream;
 * - `setChatMode('error')` forces a 500 on `/chat/completions` to exercise
 *   upstream-failure paths (reset with `setChatMode('ok')`).
 */

/** Captured `/chat/completions` request body (openai SDK JSON payload). */
export interface AiChatCompletionCapture {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

export interface AiStubOptions {
  /** Model ids returned by `GET /models`. */
  models: string[];
  /** Assistant text returned by every successful `/chat/completions`. */
  reply: string;
}

export interface AiStub {
  /** OpenAI-style base URL, e.g. `http://127.0.0.1:54321/v1`. */
  baseUrl: string;
  /** `ok` (default) answers with `reply`; `error` returns HTTP 500. */
  setChatMode(mode: 'ok' | 'error'): void;
  /** All captured `/chat/completions` bodies, in arrival order. */
  readonly chatRequests: AiChatCompletionCapture[];
  lastChatRequest(): AiChatCompletionCapture | undefined;
  close(): Promise<void>;
}

/** Start the stub on an ephemeral 127.0.0.1 port. Call `close()` in afterAll. */
export async function startAiStub(opts: AiStubOptions): Promise<AiStub> {
  let chatMode: 'ok' | 'error' = 'ok';
  const chatRequests: AiChatCompletionCapture[] = [];

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: opts.models.map((id) => ({ id, object: 'model' })),
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        try {
          chatRequests.push(
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as AiChatCompletionCapture,
          );
        } catch {
          // Non-JSON body: still respond, tests will notice the missing capture.
        }
        if (chatMode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stub upstream failure' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: opts.reply } }],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub failed to bind a port');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    setChatMode(mode) {
      chatMode = mode;
    },
    chatRequests,
    lastChatRequest() {
      return chatRequests[chatRequests.length - 1];
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
