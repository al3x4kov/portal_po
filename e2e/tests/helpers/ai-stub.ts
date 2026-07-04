import { createServer, type Server } from 'node:http';

/**
 * Shared OpenAI-compatible AI Hub stub for E2E (tasks 8, 9 and 11).
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
 *
 * Extras for task 11 (AI documentation import):
 * - extraction calls are detected by their DISTINCT system prompt («Ты —
 *   экстрактор требований…», services/aiImportPrompt.ts) — chat replies keep
 *   using `opts.reply`, extraction replies return a STRICT JSON array of
 *   `{type, name, description, source, parentName?}` records looked up in
 *   `opts.extractionItemsByFile` by the doc file name (parsed from the user
 *   message «Файл: <name> (фрагмент i из n)»; `<name>` is the RELATIVE path
 *   inside the archive, so nested files match keys like `docs/api/auth.md`);
 *   unknown files yield `[]`;
 * - extraction requests are additionally captured in `extractionRequests`
 *   (model + call count assertions);
 * - `setExtractionDelay(ms)` delays every extraction reply, so running /
 *   cancel / confirm-on-close scenarios have a deterministic time window
 *   (chat replies are never delayed — tasks 8/9/10 stay fast);
 * - the existing `setChatMode('error')` also 500s extraction calls (stage
 *   failure scenario).
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
  /** Assistant text returned by every successful chat `/chat/completions`. */
  reply: string;
  /**
   * Task 11: extraction records per documentation file name. An extraction
   * call for `auth.md` answers with `JSON.stringify(extractionItemsByFile['auth.md'] ?? [])`.
   * Deterministic by design — the same archive always yields the same records
   * (idempotency scenario relies on this).
   */
  extractionItemsByFile?: Record<string, unknown[]>;
}

export interface AiStub {
  /** OpenAI-style base URL, e.g. `http://127.0.0.1:54321/v1`. */
  baseUrl: string;
  /** `ok` (default) answers with `reply`; `error` returns HTTP 500. */
  setChatMode(mode: 'ok' | 'error'): void;
  /** All captured `/chat/completions` bodies, in arrival order. */
  readonly chatRequests: AiChatCompletionCapture[];
  lastChatRequest(): AiChatCompletionCapture | undefined;
  /** Task 11: only the extraction-prompt `/chat/completions` bodies. */
  readonly extractionRequests: AiChatCompletionCapture[];
  /** Task 11: delay (ms) applied to every extraction reply; 0 disables. */
  setExtractionDelay(ms: number): void;
  close(): Promise<void>;
}

/** Marker of the import extraction system prompt (services/aiImportPrompt.ts). */
const EXTRACTION_PROMPT_MARKER = 'экстрактор требований';

/**
 * Pull the doc file name out of «Файл: <name> (фрагмент i из n)…». The name is
 * the archive-relative path (may contain directories, e.g. `docs/api/auth.md`);
 * `.` never crosses the newline after the first line, so the trailing context
 * lines («Директория текущего файла: …», «Структура архива…») never leak in.
 */
function extractionFileName(body: AiChatCompletionCapture | undefined): string | null {
  const user = body?.messages?.find((m) => m.role === 'user');
  const match = /^Файл: (.+) \(фрагмент \d+ из \d+\)/.exec(user?.content ?? '');
  return match?.[1] ?? null;
}

/** Start the stub on an ephemeral 127.0.0.1 port. Call `close()` in afterAll. */
export async function startAiStub(opts: AiStubOptions): Promise<AiStub> {
  let chatMode: 'ok' | 'error' = 'ok';
  let extractionDelayMs = 0;
  const chatRequests: AiChatCompletionCapture[] = [];
  const extractionRequests: AiChatCompletionCapture[] = [];

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
        let body: AiChatCompletionCapture | undefined;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AiChatCompletionCapture;
          chatRequests.push(body);
        } catch {
          // Non-JSON body: still respond, tests will notice the missing capture.
        }
        const system = body?.messages?.[0];
        const isExtraction =
          system?.role === 'system' && system.content.includes(EXTRACTION_PROMPT_MARKER);
        if (isExtraction && body) extractionRequests.push(body);

        const respond = (): void => {
          if (chatMode === 'error') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'stub upstream failure' } }));
            return;
          }
          const content = isExtraction
            ? JSON.stringify(opts.extractionItemsByFile?.[extractionFileName(body) ?? ''] ?? [])
            : opts.reply;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-stub',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content } }],
            }),
          );
        };
        // Only extraction replies are delayed (running/cancel scenarios need a
        // window); chat replies stay instant so tasks 8/9/10 keep their pace.
        if (isExtraction && extractionDelayMs > 0) setTimeout(respond, extractionDelayMs);
        else respond();
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
    extractionRequests,
    setExtractionDelay(ms) {
      extractionDelayMs = ms;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
