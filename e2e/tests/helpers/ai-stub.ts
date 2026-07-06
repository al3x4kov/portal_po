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
 *
 * Extras for task 13 (structure stage — tree via AI hub):
 * - structure calls are detected by THEIR distinct system prompt («Ты —
 *   архитектор дерева требований…», buildStructureMessages); the stub parses
 *   the BATCH lines of the user message and ECHOES one node per batch item —
 *   a STRICT JSON array of `{type, name, parentName}` where `parentName`
 *   comes from the active parents map (`opts.structureParents` /
 *   `setStructureParents`) and is `null` for everything else, so ANY archive
 *   gets a valid structure answer;
 * - structure requests are captured in `structureRequests`;
 * - `setStructureDelay(ms)` delays structure replies only (stage-visibility
 *   scenario needs the 800 ms poller to catch the `structure` stage);
 * - `failNextExtractionJson(n)` / `failNextStructureJson(n)` make the next
 *   `n` matching replies a NON-JSON sentence (HTTP 200) — the JSON-retry
 *   scenarios of task 13 A3/B2.
 *
 * Task 14 (tree validity) format change: the structure user message now has
 * THREE sections (buildStructureMessages) — the archive map, the FULL list of
 * allowed parents (`TYPE\t<имя>` lines after «Полный список требований
 * (допустимые родители):») and the batch itself (`TYPE\t<имя>\t<источник>`
 * lines after «Батч (N шт., …):»). The stub echoes ONLY the batch section
 * (`structureBatchOf`); tests can additionally parse the parents section via
 * the exported `structureParentsListOf`. `setStructureExtraNodes` appends
 * arbitrary FOREIGN nodes to every structure answer — the coverage-report
 * scenario of task 14 B5 («посторонних узлов проигнорировано»).
 *
 * Task 15 (RELATES_TO НФТ→ФТ): extraction records may now carry an optional
 * `relatedFunctions: string[]` — tests override the WHOLE extraction fixture
 * map per test via `setExtractionItems` (same discipline as
 * `setStructureParents`: `null` restores the constructor default), so the
 * shared beforeAll fixtures stay untouched.
 *
 * todo_16 A3 (model-list refresh): `setModels(models)` swaps the list served
 * by `GET /models` for subsequent calls (`null` restores the constructor
 * list) — the refresh-button scenarios need the list to CHANGE between two
 * requests, including the selected model vanishing.
 *
 * todo_16 B2 (optional relate step «Проставление связей ФТ↔НФТ»): relate
 * calls are detected by their distinct system prompt («аналитик связей
 * требований», buildRelateMessages) and captured in `relateRequests`. The
 * user message carries the ALREADY-created requirements as `slug\tname\tdesc`
 * lines in two sections (ФТ / НФТ, parse via the exported `relateListsOf`);
 * the stub answers a STRICT JSON array of `{nfr, function}` SLUG pairs built
 * from `setRelatePairsByName` (NFR NAME → FUNCTION NAMEs, resolved to slugs
 * against the parsed lists — tests never have to know slugs up front), plus
 * `setRelateRawPairs` verbatim (fabricated ids the pipeline must drop).
 * `setRelateDelay(ms)` delays relate replies only (the «выполняется…» status
 * needs a window for the 800 ms poller); `failNextRelateJson(n)` makes the
 * next `n` relate replies a NON-JSON sentence — with n ≥ retry attempts the
 * step degrades to «пропущен из-за ошибки AI» without failing the import.
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
  /**
   * Task 13: default `parentName` per requirement NAME for structure answers.
   * Requirements not present in the map are answered with `parentName: null`
   * (roots). Override per test with `setStructureParents`.
   */
  structureParents?: Record<string, string>;
}

export interface AiStub {
  /** OpenAI-style base URL, e.g. `http://127.0.0.1:54321/v1`. */
  baseUrl: string;
  /** `ok` (default) answers with `reply`; `error` returns HTTP 500. */
  setChatMode(mode: 'ok' | 'error'): void;
  /**
   * todo_16 A3: models served by `GET /models` from now on; `null` restores
   * the constructor list. Always restore in `finally` — the stub is shared
   * by every test of the spec file.
   */
  setModels(models: string[] | null): void;
  /**
   * todo_18: when enabled, every model answer is wrapped in a LEADING
   * `<think>…</think>` reasoning block around the real JSON/text payload —
   * emulating a «thinking» model (Qwen3.5/3.6). Lets E2E prove the server's
   * reasoning-strip (`reasoning: 'strip'`) unblocks JSON extraction, relate and
   * structure stages. Opt-in and OFF by default, so no other spec is affected;
   * always restore with `setThinkWrap(false)` in `finally`.
   */
  setThinkWrap(enabled: boolean): void;
  /** All captured `/chat/completions` bodies, in arrival order. */
  readonly chatRequests: AiChatCompletionCapture[];
  lastChatRequest(): AiChatCompletionCapture | undefined;
  /** Task 11: only the extraction-prompt `/chat/completions` bodies. */
  readonly extractionRequests: AiChatCompletionCapture[];
  /** Task 11: delay (ms) applied to every extraction reply; 0 disables. */
  setExtractionDelay(ms: number): void;
  /**
   * Task 15: replace the extraction fixture map for the NEXT extraction
   * replies (records may carry `relatedFunctions`); `null` restores the
   * `extractionItemsByFile` passed to `startAiStub`.
   */
  setExtractionItems(map: Record<string, unknown[]> | null): void;
  /** Task 13: only the structure-prompt `/chat/completions` bodies. */
  readonly structureRequests: AiChatCompletionCapture[];
  /** Task 13: parents map for structure answers; `null` restores the default. */
  setStructureParents(map: Record<string, string> | null): void;
  /**
   * Task 14 B5: extra nodes APPENDED to every structure answer (foreign nodes
   * the pipeline must ignore with a warn); `null`/`[]` disables.
   */
  setStructureExtraNodes(nodes: Array<Record<string, unknown>> | null): void;
  /** Task 13: delay (ms) applied to every structure reply; 0 disables. */
  setStructureDelay(ms: number): void;
  /** Task 13 A3: the next `n` extraction replies are NON-JSON text (HTTP 200). */
  failNextExtractionJson(n: number): void;
  /** Task 13 B2: the next `n` structure replies are NON-JSON text (HTTP 200). */
  failNextStructureJson(n: number): void;
  /** todo_16 B2: only the relate-prompt `/chat/completions` bodies. */
  readonly relateRequests: AiChatCompletionCapture[];
  /**
   * todo_16 B2: relate answer as NFR NAME → FUNCTION NAMEs (resolved to slugs
   * from the request's own lists; unknown names are silently dropped by the
   * stub — use `setRelateRawPairs` for deliberately fabricated ids).
   * `null` restores the default (empty map → `[]` answers).
   */
  setRelatePairsByName(map: Record<string, string[]> | null): void;
  /** todo_16 B2: raw `{nfr, function}` pairs appended VERBATIM to answers. */
  setRelateRawPairs(pairs: Array<{ nfr: string; function: string }> | null): void;
  /** todo_16 B2: delay (ms) applied to every relate reply; 0 disables. */
  setRelateDelay(ms: number): void;
  /** todo_16 B2: the next `n` relate replies are NON-JSON text (HTTP 200). */
  failNextRelateJson(n: number): void;
  close(): Promise<void>;
}

/** Marker of the import extraction system prompt (services/aiImportPrompt.ts). */
const EXTRACTION_PROMPT_MARKER = 'экстрактор требований';

/** Marker of the structure system prompt (buildStructureMessages, task 13 B2). */
const STRUCTURE_PROMPT_MARKER = 'архитектор дерева требований';

/** Marker of the relate system prompt (buildRelateMessages, todo_16 B2). */
const RELATE_PROMPT_MARKER = 'аналитик связей требований';

/** Deliberately NON-JSON model answer for the retry scenarios (task 13). */
const NON_JSON_REPLY = 'Извините, сначала пришлю требования прозой, без JSON.';

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

/** Section marker of the batch itself («Батч (N шт., …):», task 14 B4). */
const STRUCTURE_BATCH_MARKER = 'Батч (';

/** Section marker of the full allowed-parents list (task 14 B3). */
const STRUCTURE_PARENTS_MARKER = 'Полный список требований (допустимые родители):';

/** One batch line of the structure user message: type, name and provenance. */
export interface StructureBatchItem {
  type: string;
  name: string;
  /** Extraction provenance «файл § раздел» (task 14 B4). */
  source: string;
}

/**
 * Parse the BATCH section of the structure user message: `TYPE\t<имя>\t<источник>`
 * lines strictly AFTER the «Батч (N шт., …):» marker, preserving order — the
 * echo answer must contain exactly one node per item. Lines of the other
 * sections (archive map, full parents list) never leak in.
 */
export function structureBatchOf(body: AiChatCompletionCapture | undefined): StructureBatchItem[] {
  const user = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const items: StructureBatchItem[] = [];
  let inBatch = false;
  for (const line of user.split('\n')) {
    if (!inBatch) {
      if (line.startsWith(STRUCTURE_BATCH_MARKER)) inBatch = true;
      continue;
    }
    const match = /^(FUNCTION|NFR)\t([^\t]+)\t(.+)$/.exec(line);
    if (match) items.push({ type: match[1]!, name: match[2]!, source: match[3]! });
  }
  return items;
}

/**
 * Parse the FULL allowed-parents section (task 14 B3): two-field
 * `TYPE\t<имя>` lines after «Полный список требований (допустимые родители):»
 * up to the next blank line. The optional «…и ещё N требований» tail is not a
 * `TYPE\t` line and is skipped naturally.
 */
export function structureParentsListOf(
  body: AiChatCompletionCapture | undefined,
): Array<{ type: string; name: string }> {
  const user = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const items: Array<{ type: string; name: string }> = [];
  let inList = false;
  for (const line of user.split('\n')) {
    if (!inList) {
      if (line === STRUCTURE_PARENTS_MARKER) inList = true;
      continue;
    }
    if (line === '') break; // blank line ends the section (batch follows)
    const match = /^(FUNCTION|NFR)\t([^\t]+)$/.exec(line);
    if (match) items.push({ type: match[1]!, name: match[2]! });
  }
  return items;
}

/** One requirement of the relate user message (todo_16 B2): slug + name. */
export interface RelateListItem {
  slug: string;
  name: string;
}

/** Both sections of the relate user message, parsed. */
export interface RelateLists {
  functions: RelateListItem[];
  nfrs: RelateListItem[];
}

/** Section markers of the relate user message (buildRelateMessages). */
const RELATE_FN_MARKER = 'Функциональные требования (ФТ)';
const RELATE_NFR_MARKER = 'Нефункциональные требования (НФТ)';

/**
 * Parse the relate user message (todo_16 B2): `slug\tname\tdesc` lines under
 * the «Функциональные требования (ФТ)…» / «Нефункциональные требования
 * (НФТ)…» section headers. The description may be empty; the optional
 * «…и ещё N требований» truncation tail has no tabs and is skipped naturally.
 */
export function relateListsOf(body: AiChatCompletionCapture | undefined): RelateLists {
  const user = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const lists: RelateLists = { functions: [], nfrs: [] };
  let section: 'fn' | 'nfr' | null = null;
  for (const line of user.split('\n')) {
    // NFR check first — «Нефункциональные…» contains «функциональные» too.
    if (line.startsWith(RELATE_NFR_MARKER)) {
      section = 'nfr';
      continue;
    }
    if (line.startsWith(RELATE_FN_MARKER)) {
      section = 'fn';
      continue;
    }
    if (!section) continue;
    const match = /^([^\t]+)\t([^\t]+)\t(.*)$/.exec(line);
    if (!match) continue;
    const item: RelateListItem = { slug: match[1]!, name: match[2]! };
    (section === 'fn' ? lists.functions : lists.nfrs).push(item);
  }
  return lists;
}

/** Start the stub on an ephemeral 127.0.0.1 port. Call `close()` in afterAll. */
export async function startAiStub(opts: AiStubOptions): Promise<AiStub> {
  let chatMode: 'ok' | 'error' = 'ok';
  let thinkWrap = false;
  let models: string[] = opts.models;
  let extractionDelayMs = 0;
  let structureDelayMs = 0;
  let relateDelayMs = 0;
  let structureParents: Record<string, string> = opts.structureParents ?? {};
  let extractionItems: Record<string, unknown[]> = opts.extractionItemsByFile ?? {};
  let structureExtraNodes: Array<Record<string, unknown>> = [];
  let relatePairsByName: Record<string, string[]> = {};
  let relateRawPairs: Array<{ nfr: string; function: string }> = [];
  let nonJsonExtractionLeft = 0;
  let nonJsonStructureLeft = 0;
  let nonJsonRelateLeft = 0;
  const chatRequests: AiChatCompletionCapture[] = [];
  const extractionRequests: AiChatCompletionCapture[] = [];
  const structureRequests: AiChatCompletionCapture[] = [];
  const relateRequests: AiChatCompletionCapture[] = [];

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
            data: models.map((id) => ({ id, object: 'model' })),
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
        const isStructure =
          system?.role === 'system' && system.content.includes(STRUCTURE_PROMPT_MARKER);
        const isRelate = system?.role === 'system' && system.content.includes(RELATE_PROMPT_MARKER);
        if (isExtraction && body) extractionRequests.push(body);
        if (isStructure && body) structureRequests.push(body);
        if (isRelate && body) relateRequests.push(body);

        // Consume the non-JSON fault counters SYNCHRONOUSLY (before any delay)
        // so concurrent polling never races the decrement.
        let forceNonJson = false;
        if (isExtraction && nonJsonExtractionLeft > 0) {
          nonJsonExtractionLeft -= 1;
          forceNonJson = true;
        }
        if (isStructure && nonJsonStructureLeft > 0) {
          nonJsonStructureLeft -= 1;
          forceNonJson = true;
        }
        if (isRelate && nonJsonRelateLeft > 0) {
          nonJsonRelateLeft -= 1;
          forceNonJson = true;
        }

        const respond = (): void => {
          if (chatMode === 'error') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'stub upstream failure' } }));
            return;
          }
          let content: string;
          if (forceNonJson) {
            content = NON_JSON_REPLY;
          } else if (isExtraction) {
            content = JSON.stringify(extractionItems[extractionFileName(body) ?? ''] ?? []);
          } else if (isStructure) {
            // Echo every BATCH item back (task 14: `TYPE\tимя\tисточник` lines
            // after the «Батч (…)» marker); parents come from the active map,
            // everything else is an explicit root (parentName: null). Foreign
            // extra nodes (task 14 B5) are appended verbatim.
            content = JSON.stringify([
              ...structureBatchOf(body).map((item) => ({
                type: item.type,
                name: item.name,
                parentName: structureParents[item.name] ?? null,
              })),
              ...structureExtraNodes,
            ]);
          } else if (isRelate) {
            // todo_16 B2: resolve NFR NAME → FUNCTION NAMEs pairs to slug
            // pairs against the request's own two lists; raw pairs (fabricated
            // ids) are appended verbatim.
            const lists = relateListsOf(body);
            const fnSlugByName = new Map(lists.functions.map((f) => [f.name, f.slug]));
            const pairs: Array<{ nfr: string; function: string }> = [];
            for (const nfr of lists.nfrs) {
              for (const fnName of relatePairsByName[nfr.name] ?? []) {
                const fnSlug = fnSlugByName.get(fnName);
                if (fnSlug) pairs.push({ nfr: nfr.slug, function: fnSlug });
              }
            }
            content = JSON.stringify([...pairs, ...relateRawPairs]);
          } else {
            content = opts.reply;
          }
          // todo_18: emulate a «thinking» model — wrap the real payload in a
          // leading `<think>…</think>` reasoning block. A non-thinking (forced
          // non-JSON) fault is left verbatim.
          if (thinkWrap && !forceNonJson) {
            content =
              '<think>\nСначала рассуждаю над требованиями и связями между ФТ и НФТ, ' +
              'затем отвечаю строгим JSON. Этот блок должен быть вырезан сервером.\n' +
              `</think>\n${content}`;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-stub',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content } }],
            }),
          );
        };
        // Only extraction/structure replies are delayed (running/cancel/stage
        // scenarios need a window); chat replies stay instant so tasks 8/9/10
        // keep their pace.
        if (isExtraction && extractionDelayMs > 0) setTimeout(respond, extractionDelayMs);
        else if (isStructure && structureDelayMs > 0) setTimeout(respond, structureDelayMs);
        else if (isRelate && relateDelayMs > 0) setTimeout(respond, relateDelayMs);
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
    setModels(next) {
      models = next ?? opts.models;
    },
    setThinkWrap(enabled) {
      thinkWrap = enabled;
    },
    chatRequests,
    lastChatRequest() {
      return chatRequests[chatRequests.length - 1];
    },
    extractionRequests,
    setExtractionDelay(ms) {
      extractionDelayMs = ms;
    },
    setExtractionItems(map) {
      extractionItems = map ?? opts.extractionItemsByFile ?? {};
    },
    structureRequests,
    setStructureParents(map) {
      structureParents = map ?? opts.structureParents ?? {};
    },
    setStructureExtraNodes(nodes) {
      structureExtraNodes = nodes ?? [];
    },
    setStructureDelay(ms) {
      structureDelayMs = ms;
    },
    failNextExtractionJson(n) {
      nonJsonExtractionLeft = n;
    },
    failNextStructureJson(n) {
      nonJsonStructureLeft = n;
    },
    relateRequests,
    setRelatePairsByName(map) {
      relatePairsByName = map ?? {};
    },
    setRelateRawPairs(pairs) {
      relateRawPairs = pairs ?? [];
    },
    setRelateDelay(ms) {
      relateDelayMs = ms;
    },
    failNextRelateJson(n) {
      nonJsonRelateLeft = n;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
