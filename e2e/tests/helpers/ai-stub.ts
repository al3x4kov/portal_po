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
 * todo_20 (T-217): (1) extraction requests now carry FEW-SHOT example
 * user/assistant pairs BEFORE the real «Файл: … (фрагмент i из n)» message
 * (structuredOutput.ts, B3) — the file-name matcher therefore scans ALL user
 * messages for the strict pattern instead of taking the first one (the
 * few-shot user line says «(пример)» and never matches); (2) every successful
 * completion carries a deterministic `usage` block (prompt/completion tokens)
 * so the run-usage counters, the budget tracker and the final report have
 * non-zero, stable numbers to assert on.
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
 *
 * todo_23 (M1, батчинг мелких файлов): small files of ONE source class are
 * packed into a single extraction call (buildBatchExtractionMessages) — the
 * user message starts with «Пакет из N файлов одного класса (фрагмент i из
 * n).» and carries every file's text behind a «=== Файл: path ===» separator
 * line. The stub detects the batch form, parses the separator paths
 * (`batchExtractionFilesOf`) and answers with the CONCATENATION of
 * `extractionItemsByFile[path]` over the batch, preserving file order — so
 * provenance-per-file scenarios stay deterministic. Single-file calls keep
 * the historical «Файл: … (фрагмент i из n)» matching. Fault knobs for the
 * todo_23 scenarios: `failNextExtraction429(n)` answers HTTP 429 to the next
 * `n` extraction calls (parallelism-degradation → recovery log lines, M4);
 * `failExtractionAfterCalls(okCalls)` lets the first `okCalls` extraction
 * calls succeed and 500s every later one until reset with `null` (mid-run
 * failure → «сохранены в контрольной точке» → resume, M3).
 *
 * todo_22 (T-307, backlog import): backlog MATCH calls are detected by their
 * distinct system prompt («продуктовый аналитик портала управления
 * требованиями», buildBacklogMatchMessages) and captured in
 * `backlogMatchRequests`. The user message carries the batch as
 * `rowId\tключ|—\tтекст` lines after «Батч строк бэклога (…»); the stub echoes
 * ONE answer object per batch row: `{rowId, businessName, type,
 * parentExisting, parentNew, duplicateOf}`. Tests configure per-row answers
 * with `setBacklogAnswers` (keyed by the row KEY, falling back to the source
 * text); unconfigured rows default to a FUNCTION under the
 * {@link BACKLOG_DEFAULT_NEW_NODE} new root node, so ANY xlsx gets a valid
 * markup. `setBacklogDelay(ms)` delays match replies only (progress-screen
 * visibility); `failBacklogAfterCalls(n)` lets the first `n` match calls
 * succeed and 500s every later one until reset with `null` — the
 * mid-match-failure → resume scenario (the paid batch must not be re-sent).
 *
 * Schema honouring (todo_22 hotfix regression guard): like a REAL model with
 * strict structured output, the stub obeys the REQUESTED `response_format`
 * of a backlog match call. The correct `backlog_match_answers` schema gets
 * the production wrapper `{"answers":[...]}`; a FOREIGN json_schema (e.g. the
 * analyze `extracted_requirements` one, which the backend used to send by
 * mistake — 100% answers without rowId → MODEL-01) gets a reply per THAT
 * schema (`{"items":[{type,name,description,source}]}`, no rowId), so a
 * regression of the negotiator schema fails the e2e again. Calls without a
 * json_schema (json_object / none fallback modes) get the bare answers array
 * — the prompt-following path `extractJsonArray` also accepts.
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
  /**
   * todo_22: backlog match answers per row KEY (fallback: per source text).
   * Rows without a configured answer get the deterministic default (FUNCTION
   * under the {@link BACKLOG_DEFAULT_NEW_NODE} new root node).
   */
  backlogAnswers?: Record<string, BacklogMatchAnswerSpec>;
}

/**
 * todo_22: one configured backlog match answer. Omitted fields fall back to
 * deterministic defaults: `businessName` = the source text, `type` =
 * `FUNCTION`, parent = a new {@link BACKLOG_DEFAULT_NEW_NODE} root node (when
 * neither `parentExisting` nor `parentNew` is set), `duplicateOf` = null.
 */
export interface BacklogMatchAnswerSpec {
  businessName?: string;
  type?: 'FUNCTION' | 'NFR';
  parentExisting?: string | null;
  parentNew?: { name: string; parentName: string | null } | null;
  duplicateOf?: string | null;
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
  /** Тест-генерация: только запросы с QA-промптом. */
  readonly testgenRequests: AiChatCompletionCapture[];
  /** Тест-генерация: slug'и, которые стаб «пропустит» (missing → fallback). */
  setTestgenSkipSlugs(slugs: string[] | null): void;
  /** Тест-генерация: лишние кейсы, добавляемые к каждому ответу (галлюцинации). */
  setTestgenExtraCases(cases: Array<Record<string, unknown>> | null): void;
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
  /** todo_23 M4: the next `n` extraction replies are HTTP 429 (rate limit). */
  failNextExtraction429(n: number): void;
  /**
   * todo_23 M3: the first `okCalls` extraction calls succeed, every later one
   * answers HTTP 500 until reset with `null` (mid-run failure → resume).
   */
  failExtractionAfterCalls(okCalls: number | null): void;
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
  /** todo_22: only the backlog-match-prompt `/chat/completions` bodies. */
  readonly backlogMatchRequests: AiChatCompletionCapture[];
  /**
   * todo_22: per-row backlog match answers (see {@link BacklogMatchAnswerSpec});
   * `null` restores the constructor `backlogAnswers` (or the empty map).
   */
  setBacklogAnswers(map: Record<string, BacklogMatchAnswerSpec> | null): void;
  /** todo_22: delay (ms) applied to every backlog match reply; 0 disables. */
  setBacklogDelay(ms: number): void;
  /**
   * todo_22: the first `okCalls` backlog match calls succeed, every later one
   * answers HTTP 500 until reset with `null` (mid-match failure → resume).
   */
  failBacklogAfterCalls(okCalls: number | null): void;
  close(): Promise<void>;
}

/** todo_22: default new root node of unconfigured backlog match answers. */
export const BACKLOG_DEFAULT_NEW_NODE = 'Возможности продукта';

/** Marker of the import extraction system prompt (services/aiImportPrompt.ts). */
const EXTRACTION_PROMPT_MARKER = 'экстрактор требований';

/** Marker of the structure system prompt (buildStructureMessages, task 13 B2). */
const STRUCTURE_PROMPT_MARKER = 'архитектор дерева требований';

/** Marker of the relate system prompt (buildRelateMessages, todo_16 B2). */
const RELATE_PROMPT_MARKER = 'аналитик связей требований';

/** Marker of the backlog match system prompt (backlogMatchStage.ts, todo_22). */
const BACKLOG_MATCH_PROMPT_MARKER = 'продуктовый аналитик портала управления требованиями';
/** Тест-генерация (развилка «Генерации артефактов»): system prompt QA-персоны. */
const TESTGEN_PROMPT_MARKER = 'senior QA-инженер';

/** Deliberately NON-JSON model answer for the retry scenarios (task 13). */
const NON_JSON_REPLY = 'Извините, сначала пришлю требования прозой, без JSON.';

/**
 * Pull the doc file name out of «Файл: <name> (фрагмент i из n)…». The name is
 * the archive-relative path (may contain directories, e.g. `docs/api/auth.md`);
 * `.` never crosses the newline after the first line, so the trailing context
 * lines («Директория текущего файла: …», «Структура архива…») never leak in.
 */
function extractionFileName(body: AiChatCompletionCapture | undefined): string | null {
  // todo_20: few-shot example user messages (fewShotForClass) precede the real
  // payload — scan every user message for the strict «(фрагмент i из n)» form.
  for (const m of body?.messages ?? []) {
    if (m.role !== 'user') continue;
    const match = /^Файл: (.+) \(фрагмент \d+ из \d+\)/.exec(m.content ?? '');
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * todo_23 M1: pull the file paths of a BATCHED extraction call out of the
 * «=== Файл: path ===» separator lines. Returns `[]` for single-file calls —
 * only user messages of the strict batch form («Пакет из N файлов одного
 * класса (фрагмент i из n).» first line) are parsed, so few-shot examples and
 * archive-map lines never produce false positives.
 */
export function batchExtractionFilesOf(body: AiChatCompletionCapture | undefined): string[] {
  for (const m of body?.messages ?? []) {
    if (m.role !== 'user') continue;
    const content = m.content ?? '';
    if (!/^Пакет из \d+ файлов одного класса \(фрагмент \d+ из \d+\)\./.test(content)) continue;
    const files: string[] = [];
    for (const line of content.split('\n')) {
      const match = /^=== Файл: (.+) ===$/.exec(line);
      if (match) files.push(match[1]!);
    }
    return files;
  }
  return [];
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

/** Section marker of the backlog match batch (buildBacklogMatchMessages). */
const BACKLOG_BATCH_MARKER = 'Батч строк бэклога (';

/** One row of the backlog match user message (todo_22). */
export interface BacklogBatchRow {
  rowId: string;
  /** Absent when the sheet has no key column (the prompt sends «—»). */
  key?: string;
  text: string;
}

/**
 * Parse the batch section of the backlog match user message:
 * `rowId\tключ|—\tтекст` lines strictly AFTER the «Батч строк бэклога (…»
 * marker, preserving order — the echo answer must contain exactly one object
 * per row. Tree-map lines never leak in (they are `TYPE\tимя\tродитель: …`,
 * but they precede the batch marker).
 */
export function backlogBatchOf(body: AiChatCompletionCapture | undefined): BacklogBatchRow[] {
  const user = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const rows: BacklogBatchRow[] = [];
  let inBatch = false;
  for (const line of user.split('\n')) {
    if (!inBatch) {
      if (line.startsWith(BACKLOG_BATCH_MARKER)) inBatch = true;
      continue;
    }
    const match = /^([^\t]+)\t([^\t]+)\t(.+)$/.exec(line);
    if (match) {
      rows.push({
        rowId: match[1]!,
        ...(match[2] !== '—' ? { key: match[2]! } : {}),
        text: match[3]!,
      });
    }
  }
  return rows;
}

/**
 * Name of the requested strict `json_schema` of a captured call, or undefined
 * for the `json_object` / no-format fallback modes (todo_22 hotfix guard —
 * the stage schema must match the parser of the stage that owns the call).
 */
export function jsonSchemaNameOf(body: AiChatCompletionCapture | undefined): string | undefined {
  const rf = body?.response_format as
    { type?: string; json_schema?: { name?: string } } | undefined;
  return rf?.type === 'json_schema' ? rf.json_schema?.name : undefined;
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
  let rateLimit429ExtractionLeft = 0;
  let extractionOkCallsLeft: number | null = null;
  let nonJsonStructureLeft = 0;
  let nonJsonRelateLeft = 0;
  let backlogAnswers: Record<string, BacklogMatchAnswerSpec> = opts.backlogAnswers ?? {};
  let backlogDelayMs = 0;
  let backlogOkCallsLeft: number | null = null;
  let testgenSkipSlugs: string[] = [];
  let testgenExtraCases: Array<Record<string, unknown>> = [];
  const chatRequests: AiChatCompletionCapture[] = [];
  const testgenRequests: AiChatCompletionCapture[] = [];
  const extractionRequests: AiChatCompletionCapture[] = [];
  const structureRequests: AiChatCompletionCapture[] = [];
  const relateRequests: AiChatCompletionCapture[] = [];
  const backlogMatchRequests: AiChatCompletionCapture[] = [];

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
        const isBacklogMatch =
          system?.role === 'system' && system.content.includes(BACKLOG_MATCH_PROMPT_MARKER);
        const isTestgen =
          system?.role === 'system' && system.content.includes(TESTGEN_PROMPT_MARKER);
        if (isTestgen && body) testgenRequests.push(body);
        if (isExtraction && body) extractionRequests.push(body);
        if (isStructure && body) structureRequests.push(body);
        if (isRelate && body) relateRequests.push(body);
        if (isBacklogMatch && body) backlogMatchRequests.push(body);

        // Consume the non-JSON fault counters SYNCHRONOUSLY (before any delay)
        // so concurrent polling never races the decrement.
        let forceNonJson = false;
        if (isExtraction && nonJsonExtractionLeft > 0) {
          nonJsonExtractionLeft -= 1;
          forceNonJson = true;
        }
        // todo_23 M4: consume the 429 counter synchronously (parallel calls
        // must never race the decrement).
        let force429 = false;
        if (isExtraction && rateLimit429ExtractionLeft > 0) {
          rateLimit429ExtractionLeft -= 1;
          force429 = true;
        }
        // todo_23 M3: spend the extraction ok-calls budget synchronously too.
        let forceExtractionFail = false;
        if (isExtraction && !force429 && extractionOkCallsLeft !== null) {
          if (extractionOkCallsLeft > 0) extractionOkCallsLeft -= 1;
          else forceExtractionFail = true;
        }
        if (isStructure && nonJsonStructureLeft > 0) {
          nonJsonStructureLeft -= 1;
          forceNonJson = true;
        }
        if (isRelate && nonJsonRelateLeft > 0) {
          nonJsonRelateLeft -= 1;
          forceNonJson = true;
        }
        // todo_22: consume the ok-calls budget synchronously too — after it is
        // spent, every backlog match call is a 500 until the budget is reset.
        let forceBacklogFail = false;
        if (isBacklogMatch && backlogOkCallsLeft !== null) {
          if (backlogOkCallsLeft > 0) backlogOkCallsLeft -= 1;
          else forceBacklogFail = true;
        }

        const respond = (): void => {
          if (force429) {
            // todo_23 M4: rate limit — no Retry-After, the client backs off.
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'stub rate limit' } }));
            return;
          }
          if (chatMode === 'error' || forceBacklogFail || forceExtractionFail) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'stub upstream failure' } }));
            return;
          }
          let content: string;
          if (forceNonJson) {
            content = NON_JSON_REPLY;
          } else if (isExtraction) {
            // todo_23 M1: a batched call answers the CONCATENATION of the
            // per-file fixtures over the separator paths, in batch order.
            const batchFiles = batchExtractionFilesOf(body);
            content =
              batchFiles.length > 0
                ? JSON.stringify(batchFiles.flatMap((f) => extractionItems[f] ?? []))
                : JSON.stringify(extractionItems[extractionFileName(body) ?? ''] ?? []);
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
          } else if (isTestgen) {
            // Тест-генерация: детерминированный кейс на каждую строку батча
            // `slug\tтип\tкритичность\tимя\tописание`; пропуски и лишние
            // кейсы настраиваются тестом (missing / галлюцинации).
            const userMsg = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
            const rows = userMsg
              .split('\n')
              .filter((line) => line.includes('\t'))
              .map((line) => {
                const [slug, , , name] = line.split('\t');
                return { slug: slug ?? '', name: name ?? '' };
              })
              .filter((r) => r.slug.length > 0 && !testgenSkipSlugs.includes(r.slug));
            const negatives = system?.content.includes('обязательны') ?? false;
            content = JSON.stringify({
              cases: [
                ...rows.map((r) => ({
                  slug: r.slug,
                  title: `AI-кейс: ${r.name}`,
                  goal: `Проверить «${r.name}» по описанию`,
                  precondition: 'Приложение запущено, проект открыт',
                  steps: ['Выполнить основное действие', 'Проверить результат'],
                  expected: 'Функция работает по описанию',
                  ...(negatives
                    ? {
                        negativeSteps: ['Передать невалидные данные'],
                        negativeExpected: 'Понятная ошибка, состояние не повреждено',
                      }
                    : {}),
                })),
                ...testgenExtraCases,
              ],
            });
          } else if (isBacklogMatch) {
            // todo_22: echo one answer per batch row — configured spec by row
            // KEY (fallback: source text), deterministic defaults otherwise.
            const batch = backlogBatchOf(body);
            const schemaName = jsonSchemaNameOf(body);
            if (schemaName !== undefined && schemaName !== 'backlog_match_answers') {
              // Hotfix repro: a strict-schema model FOLLOWS the (wrong) schema
              // it was given — analyze-style items WITHOUT rowId, 100%
              // unparseable by the match stage. A negotiator-schema regression
              // (match calls sent with `extracted_requirements`) fails again.
              content = JSON.stringify({
                items: batch.map((row) => ({
                  type: 'FUNCTION',
                  name: row.text.slice(0, 60),
                  description: row.text,
                  source: `бэклог, строка ${row.rowId}`,
                })),
              });
            } else {
              const answers = batch.map((row) => {
                const spec =
                  (row.key !== undefined ? backlogAnswers[row.key] : undefined) ??
                  backlogAnswers[row.text] ??
                  {};
                const parentExisting = spec.parentExisting ?? null;
                const parentNew =
                  spec.parentNew !== undefined
                    ? spec.parentNew
                    : parentExisting !== null
                      ? null
                      : { name: BACKLOG_DEFAULT_NEW_NODE, parentName: null };
                return {
                  rowId: row.rowId,
                  businessName: spec.businessName ?? row.text,
                  type: spec.type ?? 'FUNCTION',
                  parentExisting,
                  parentNew,
                  duplicateOf: spec.duplicateOf ?? null,
                };
              });
              // Production wrapper for the strict schema; bare array for the
              // prompt-following fallback modes (json_object / none).
              content =
                schemaName === 'backlog_match_answers'
                  ? JSON.stringify({ answers })
                  : JSON.stringify(answers);
            }
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
              // todo_20 C4: deterministic usage so token counters/report/budget
              // have stable non-zero numbers in E2E.
              usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
            }),
          );
        };
        // Only extraction/structure replies are delayed (running/cancel/stage
        // scenarios need a window); chat replies stay instant so tasks 8/9/10
        // keep their pace.
        if (isExtraction && extractionDelayMs > 0) setTimeout(respond, extractionDelayMs);
        else if (isStructure && structureDelayMs > 0) setTimeout(respond, structureDelayMs);
        else if (isRelate && relateDelayMs > 0) setTimeout(respond, relateDelayMs);
        else if (isBacklogMatch && backlogDelayMs > 0) setTimeout(respond, backlogDelayMs);
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
    failNextExtraction429(n) {
      rateLimit429ExtractionLeft = n;
    },
    failExtractionAfterCalls(okCalls) {
      extractionOkCallsLeft = okCalls;
    },
    failNextStructureJson(n) {
      nonJsonStructureLeft = n;
    },
    relateRequests,
    testgenRequests,
    setTestgenSkipSlugs(slugs) {
      testgenSkipSlugs = slugs ?? [];
    },
    setTestgenExtraCases(cases) {
      testgenExtraCases = cases ?? [];
    },
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
    backlogMatchRequests,
    setBacklogAnswers(map) {
      backlogAnswers = map ?? opts.backlogAnswers ?? {};
    },
    setBacklogDelay(ms) {
      backlogDelayMs = ms;
    },
    failBacklogAfterCalls(okCalls) {
      backlogOkCallsLeft = okCalls;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
