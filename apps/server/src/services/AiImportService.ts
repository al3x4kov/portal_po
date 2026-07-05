import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AI_IMPORT_CHUNK_CHARS,
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_MAX_TOKENS,
  AI_IMPORT_STRUCTURE_BATCH,
  AI_IMPORT_STRUCTURE_MAX_TOKENS,
  AI_IMPORT_TEMPERATURE,
  DomainError,
  TARGET_QUARTERS,
  type AiExtractedRequirement,
  type AiImportJobView,
  type AiImportResult,
  type AiImportStartResponse,
  type Link,
  type Requirement,
  type TargetQuarter,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import type { RequirementService } from './RequirementService.js';
import type { LinkService } from './LinkService.js';
import type { AiClient, AiClientFactory } from './AiHubService.js';
import type { AiImportJobs, AiImportJobState } from './AiImportJobs.js';
import type { OpLogger } from '../lib/logger.js';
import { unpackDocsArchive, type UnpackedDocs } from '../lib/unpack.js';
import type { AiChatMessage } from './aiPrompt.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import {
  buildArchiveMap,
  buildExtractionMessages,
  buildStructureMessages,
  chunkText,
  parseExtractionResponse,
  parseStructureResponse,
  type ParsedExtraction,
  type ParsedStructure,
  type StructureItem,
} from './aiImportPrompt.js';

/* Mandatory user-facing texts (spec §4): readable message + "what to do next". */
export const AI_IMPORT_HINT_ARCHIVE =
  'Проверьте формат архива (zip или tar.gz) и размер до 50 МБ, соберите архив заново и повторите';
export const AI_IMPORT_HINT_NO_DOCS =
  'В архиве нет файлов документации (.md/.txt). Добавьте документацию в архив и повторите';
export const AI_IMPORT_HINT_CONFIGURE =
  'Настройте AI Hub: задайте API-ключ на экране AI и выберите модель';
export const AI_IMPORT_HINT_UPSTREAM =
  'Проверьте доступность AI Hub, корректность API-ключа и повторите анализ';
export const AI_IMPORT_HINT_UNPARSEABLE =
  'Модель вернула неструктурированный ответ. Попробуйте другую модель или повторите';
export const AI_IMPORT_HINT_POPULATE =
  'Часть элементов не создана (см. лог). Исправьте данные в проекте и повторите — существующие не будут задублированы';

/** Defaults applied for gaps in the source (PO decision §3.1). */
export const AI_IMPORT_DEFAULT_CRITICALITY = 'MEDIUM' as const;

/** Attempts per AI call when the answer is not a valid JSON array (Task 13 A3/B2). */
export const AI_IMPORT_JSON_ATTEMPTS = 3;

/** Next calendar quarter after `nowIso` (default target for unimplemented). */
export function nextQuarterOf(nowIso: string): {
  targetQuarter: TargetQuarter;
  targetYear: number;
} {
  const date = new Date(nowIso);
  const quarterIndex = Math.floor(date.getUTCMonth() / 3); // 0..3
  const nextIndex = (quarterIndex + 1) % 4;
  const targetYear = nextIndex === 0 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  return { targetQuarter: TARGET_QUARTERS[nextIndex] as TargetQuarter, targetYear };
}

/** Redact any occurrence of the secret key from an outbound message (Task 8). */
function sanitize(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('***');
}

/** Case-insensitive, trimmed identity of a requirement name within a type. */
function nameKey(type: string, name: string): string {
  return `${type}:${name.trim().toLowerCase()}`;
}

/**
 * Task 15: union of two `relatedFunctions` lists, deduplicated by the
 * case-insensitive FUNCTION name key. The FIRST encountered formulation of a
 * name wins (per spec: duplicates of one NFR merge their related functions
 * while keeping the first-seen wording). Returns `undefined` when both inputs
 * are empty/absent so the field stays optional.
 */
function unionRelatedFunctions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const name of [...(a ?? []), ...(b ?? [])]) {
    const key = nameKey('FUNCTION', name);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(name);
  }
  return union.length > 0 ? union : undefined;
}

/**
 * Task 14 B6: deterministically break parent cycles in a child→parent map
 * (keys are {@link nameKey} identities). Chains are walked in map insertion
 * order; when a walk revisits a node of its own path, the parent edge of the
 * LAST node on the path (the edge closing the cycle) is dropped, making that
 * node a root. Pure: the input map is never mutated; the returned list holds
 * the child keys whose parent edge must be removed, in detection order.
 */
export function breakParentCycles(parentByChild: ReadonlyMap<string, string>): string[] {
  const parents = new Map(parentByChild);
  const removed: string[] = [];
  const safe = new Set<string>(); // nodes proven to terminate
  for (const start of parents.keys()) {
    if (safe.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = start;
    for (;;) {
      if (onPath.has(cur)) {
        const closing = path[path.length - 1]!;
        parents.delete(closing);
        removed.push(closing);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      const next = parents.get(cur);
      if (next === undefined || safe.has(next)) break;
      cur = next;
    }
    for (const key of path) safe.add(key);
  }
  return removed;
}

/**
 * Diagnostic for «no documentation files» (spec §4: readable, actionable):
 * instead of a mute refusal, tell the user WHAT the archive actually holds —
 * total file count, extension breakdown, and unsafe-entry count when present.
 */
export function noDocsMessage(
  stats: Pick<UnpackedDocs, 'totalEntries' | 'extensionCounts' | 'unsafeEntries'>,
): string {
  if (stats.totalEntries === 0) return 'Архив пуст.';
  const breakdown = Object.entries(stats.extensionCounts)
    .sort(([extA, countA], [extB, countB]) => countB - countA || extA.localeCompare(extB))
    .map(([ext, count]) => `${ext === '' ? '(без расширения)' : ext} — ${count}`)
    .join(', ');
  let message =
    `В архиве нет файлов документации (.md/.markdown/.txt). ` +
    `В архиве ${stats.totalEntries} файлов${breakdown ? `: ${breakdown}` : ''}.`;
  if (stats.unsafeEntries > 0) {
    message += ` Пропущено небезопасных записей: ${stats.unsafeEntries} (пути вне каталога распаковки).`;
  }
  return message;
}

export interface AiImportServiceDeps {
  now: () => string;
  jobs: AiImportJobs;
  configRepo: AiConfigRepo;
  makeAiClient: AiClientFactory;
  makeRequirementService: (projectId: string) => RequirementService;
  makeLinkService: (projectId: string) => LinkService;
  projectExists: (projectId: string) => Promise<boolean>;
  log?: OpLogger;
  /** Chunk size override for tests; production uses the core constant. */
  chunkChars?: number;
  /** Structure batch size override for tests; production uses the core constant (50). */
  structureBatch?: number;
}

/** One aggregated record plus its resolved parent (by name, same type). */
interface AggregatedRecord {
  record: AiExtractedRequirement;
  parentKey?: string;
  /** Effective parent name (from the structure stage) — for log messages. */
  parentName?: string;
}

/** Outcome of one AI call with JSON retries (Task 13 A3/B2). */
type JsonCallOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unparsed' }
  | { kind: 'cancelled' }
  | { kind: 'upstream'; error: Error };

/**
 * A record whose extracted CHILD_OF should be ensured after populate: either a
 * freshly created requirement, or a skipped EXISTING one (re-run after a crash
 * between requirement and link creation — PO decision: the missing link is
 * still created, existing links are never touched or duplicated).
 */
interface LinkCandidate {
  item: AggregatedRecord;
  /** Snapshot links of an already-existing source; used to skip present links. */
  existingLinks?: Link[];
}

/**
 * Use-case service for «AI подгрузка ФТ/НФТ из документации» (Task 11/13):
 * unpack → analyze (sequential chunked AI calls) → structure (tree via the
 * AI hub over the full extracted set) → aggregate → populate.
 * Runs as an in-memory job the client polls; creation goes through the
 * EXISTING RequirementService/LinkService so every core rule applies.
 */
export class AiImportService {
  private readonly deps: AiImportServiceDeps;
  private readonly running = new Map<string, Promise<void>>();

  constructor(deps: AiImportServiceDeps) {
    this.deps = deps;
  }

  /**
   * Validate preconditions (spec: project 404 → key/model 400 → size 400 →
   * running job 409) and launch the asynchronous run. Returns immediately
   * with the job id; the route answers 202.
   */
  async start(
    projectId: string,
    archivePath: string,
    modelOverride?: string,
  ): Promise<AiImportStartResponse> {
    if (!(await this.deps.projectExists(projectId))) {
      throw new NotFoundError(`Project not found: "${projectId}".`);
    }

    const cfg = await this.deps.configRepo.read();
    const model = modelOverride ?? cfg.modelByProject[projectId];
    if (!cfg.apiKey || !model) {
      throw new BadRequestError(AI_IMPORT_HINT_CONFIGURE);
    }

    const stat = await fs.stat(archivePath);
    if (stat.size > AI_IMPORT_MAX_ARCHIVE_BYTES) {
      throw new BadRequestError(`Архив превышает лимит 50 МБ. ${AI_IMPORT_HINT_ARCHIVE}`);
    }

    const job = this.deps.jobs.create(projectId); // ConflictError (409) when running

    const run = this.run(job, archivePath, model, cfg.apiKey, cfg.baseURL)
      .catch((err: unknown) => {
        // Belt-and-braces: run() handles its own failures; this guards a bug in run() itself.
        this.logLine(job, 'error', `Внутренняя ошибка автоматизации: ${(err as Error).message}`);
        if (job.status === 'running') {
          job.error = { message: (err as Error).message, hint: AI_IMPORT_HINT_ARCHIVE };
          this.deps.jobs.finish(job, 'failed');
        }
      })
      .finally(() => {
        this.running.delete(job.jobId);
        void fs.rm(archivePath, { force: true }).catch(() => {});
      });
    this.running.set(job.jobId, run);

    return { jobId: job.jobId };
  }

  /** Client view of a job. 404 when unknown or expired. */
  getView(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    return this.deps.jobs.view(job);
  }

  /**
   * Request cancellation (idempotent; a no-op after completion). The runner
   * honours the flag at the next chunk boundary (spec §2, cancel semantics).
   */
  cancel(jobId: string): AiImportJobView {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`AI import job not found: "${jobId}".`);
    if (job.status === 'running' && !job.cancelRequested) {
      job.cancelRequested = true;
      this.logLine(job, 'info', 'Получен запрос на остановку автоматизации.');
    }
    return this.deps.jobs.view(job);
  }

  /** Await the background run of a job (test synchronization helper). */
  async waitForCompletion(jobId: string): Promise<void> {
    await (this.running.get(jobId) ?? Promise.resolve());
  }

  private logLine(job: AiImportJobState, level: 'info' | 'warn' | 'error', message: string): void {
    job.log.push({ ts: this.deps.now(), level, message });
  }

  /**
   * Task 14 B6: one-line tree summary after parent resolution and cycle
   * breaking. Depth: a root is 1; a parent outside the aggregated set (an
   * already-existing project requirement) counts as depth 1. Cycles are
   * already broken, so the walk terminates.
   */
  private treeSummary(aggregated: AggregatedRecord[]): string {
    const parentOf = new Map<string, string>();
    for (const item of aggregated) {
      if (item.parentKey) {
        parentOf.set(nameKey(item.record.type, item.record.name), item.parentKey);
      }
    }
    const depthOf = (key: string): number => {
      let depth = 1;
      for (let cur = parentOf.get(key); cur !== undefined; cur = parentOf.get(cur)) depth += 1;
      return depth;
    };
    let fnRoots = 0;
    let fnChildren = 0;
    let nfrRoots = 0;
    let nfrChildren = 0;
    let maxDepth = 0;
    for (const item of aggregated) {
      const isChild = item.parentKey !== undefined;
      if (item.record.type === 'FUNCTION') {
        if (isChild) fnChildren += 1;
        else fnRoots += 1;
      } else if (isChild) nfrChildren += 1;
      else nfrRoots += 1;
      const depth = depthOf(nameKey(item.record.type, item.record.name));
      if (depth > maxDepth) maxDepth = depth;
    }
    return (
      `Дерево: ФТ — ${fnRoots} корней, ${fnChildren} с родителем; ` +
      `НФТ — ${nfrRoots} корней, ${nfrChildren} с родителем; максимальная глубина ${maxDepth}.`
    );
  }

  private fail(job: AiImportJobState, message: string, hint: string): void {
    this.logLine(job, 'error', message);
    job.error = { message, hint };
    this.deps.jobs.finish(job, 'failed');
  }

  /** Honour a pending cancel request; returns true when the job was stopped. */
  private cancelIfRequested(job: AiImportJobState, counters: AiImportResult): boolean {
    if (!job.cancelRequested) return false;
    job.result = { ...counters };
    this.logLine(
      job,
      'warn',
      `Автоматизация остановлена пользователем. Создано к моменту остановки: ` +
        `ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}, связей ${counters.links}, ` +
        `связей НФТ→ФТ: ${counters.relatesLinks}.`,
    );
    this.deps.jobs.finish(job, 'cancelled');
    return true;
  }

  /**
   * One AI call with up to {@link AI_IMPORT_JSON_ATTEMPTS} attempts while the
   * answer cannot be parsed (Task 13 A3/B2). Every failed attempt is logged
   * via `attemptWarn`; a pending cancel is honoured BETWEEN attempts (the job
   * is then already finished as cancelled). Upstream/network errors are never
   * retried — the caller decides what they mean for the job.
   *
   * Task 14: `maxTokens` is per-call (extraction 2000 vs structure 4000, B1);
   * a `finish_reason === 'length'` answer logs `truncatedWarn` (B2); when
   * `parseFinal` is given, it replaces `parse` on the LAST attempt (lenient
   * salvage instead of losing the whole batch, B7).
   */
  private async chatWithJsonRetries<T>(args: {
    job: AiImportJobState;
    counters: AiImportResult;
    client: AiClient;
    model: string;
    messages: AiChatMessage[];
    maxTokens: number;
    parse: (content: string) => T | null;
    /** Lenient parser for the last attempt (Task 14 B7); defaults to `parse`. */
    parseFinal?: (content: string) => T | null;
    attemptWarn: (attempt: number) => string;
    truncatedWarn: (attempt: number) => string;
  }): Promise<JsonCallOutcome<T>> {
    for (let attempt = 1; attempt <= AI_IMPORT_JSON_ATTEMPTS; attempt++) {
      let content: string;
      try {
        const res = await args.client.chat.completions.create({
          model: args.model,
          messages: args.messages,
          temperature: AI_IMPORT_TEMPERATURE,
          max_tokens: args.maxTokens,
        });
        content = res.choices?.[0]?.message?.content ?? '';
        if (res.choices?.[0]?.finish_reason === 'length') {
          this.logLine(args.job, 'warn', args.truncatedWarn(attempt));
        }
      } catch (err) {
        return { kind: 'upstream', error: err as Error };
      }
      const parse =
        attempt === AI_IMPORT_JSON_ATTEMPTS && args.parseFinal ? args.parseFinal : args.parse;
      const value = parse(content);
      if (value !== null) return { kind: 'ok', value };
      this.logLine(args.job, 'warn', args.attemptWarn(attempt));
      if (attempt < AI_IMPORT_JSON_ATTEMPTS && this.cancelIfRequested(args.job, args.counters)) {
        return { kind: 'cancelled' };
      }
    }
    return { kind: 'unparsed' };
  }

  /** The asynchronous pipeline. Never throws for expected failures — it fails the job. */
  private async run(
    job: AiImportJobState,
    archivePath: string,
    model: string,
    apiKey: string,
    baseURL: string,
  ): Promise<void> {
    const counters: AiImportResult = {
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 0,
    };
    let docsDir: string | undefined;
    try {
      // ── unpack (0–5) ────────────────────────────────────────────────────
      job.stage = 'unpack';
      this.logLine(job, 'info', 'Распаковка архива документации…');
      let unpacked: UnpackedDocs;
      try {
        unpacked = await unpackDocsArchive(archivePath);
        docsDir = unpacked.dir;
        if (unpacked.unsafeEntries > 0) {
          this.logLine(
            job,
            'warn',
            `Пропущено небезопасных записей архива (выход за пределы каталога): ${unpacked.unsafeEntries}.`,
          );
        }
      } catch (err) {
        this.fail(
          job,
          `Не удалось распаковать архив: ${(err as Error).message}`,
          AI_IMPORT_HINT_ARCHIVE,
        );
        return;
      }
      const files = unpacked.files;
      if (files.length === 0) {
        this.fail(job, noDocsMessage(unpacked), AI_IMPORT_HINT_NO_DOCS);
        return;
      }
      this.logLine(job, 'info', `Найдено файлов документации: ${files.length}.`);
      // Built once per job: the same compact archive map goes into every
      // extraction call so the model sees the overall structure (Task 13).
      const archiveMap = buildArchiveMap(files);
      job.progress = 5;

      // ── analyze (5–65) ──────────────────────────────────────────────────
      job.stage = 'analyze';
      const chunkChars = this.deps.chunkChars ?? AI_IMPORT_CHUNK_CHARS;
      const chunksByFile: Array<{ file: string; chunks: string[] }> = [];
      let totalChunks = 0;
      for (const file of files) {
        const text = await fs.readFile(path.join(docsDir, file), 'utf8');
        const chunks = chunkText(text, chunkChars);
        chunksByFile.push({ file, chunks });
        totalChunks += chunks.length;
      }
      if (totalChunks === 0) {
        this.fail(job, 'Файлы документации пусты — извлекать нечего.', AI_IMPORT_HINT_NO_DOCS);
        return;
      }
      // Task 14 B9: volume of the upcoming work, before the first AI call.
      this.logLine(
        job,
        'info',
        `Модель: ${model}. Файлов: ${files.length}, фрагментов: ${totalChunks}.`,
      );

      const client: AiClient = this.deps.makeAiClient(apiKey, baseURL);
      const extracted: AiExtractedRequirement[] = [];
      let processedChunks = 0;
      let parsedChunks = 0;
      for (const { file, chunks } of chunksByFile) {
        for (let i = 0; i < chunks.length; i++) {
          if (this.cancelIfRequested(job, counters)) return;

          const messages = buildExtractionMessages(
            chunks[i]!,
            file,
            { index: i + 1, total: chunks.length },
            archiveMap,
          );
          // Task 13 A3: up to 3 attempts while the answer is not a JSON array;
          // upstream errors are NOT retried and fail the job as before.
          // Task 14 B8: an array whose records are ALL invalid is a format
          // failure too — retried like non-JSON. A truly empty [] is a valid
          // «no requirements here» answer and is never retried.
          const outcome = await this.chatWithJsonRetries<ParsedExtraction>({
            job,
            counters,
            client,
            model,
            messages,
            maxTokens: AI_IMPORT_MAX_TOKENS,
            parse: (content) => {
              const parsed = parseExtractionResponse(content);
              if (
                parsed !== null &&
                parsed.items.length === 0 &&
                parsed.droppedNoSource + parsed.droppedInvalid > 0
              ) {
                return null;
              }
              return parsed;
            },
            attemptWarn: (attempt) =>
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели не распознан как JSON-массив (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
            truncatedWarn: (attempt) =>
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
          });
          if (outcome.kind === 'cancelled') return;
          if (outcome.kind === 'upstream') {
            this.fail(
              job,
              sanitize(`Ошибка обращения к AI Hub: ${outcome.error.message}`, apiKey),
              AI_IMPORT_HINT_UPSTREAM,
            );
            return;
          }

          processedChunks += 1;
          if (outcome.kind === 'unparsed') {
            this.logLine(
              job,
              'warn',
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели не распознан как JSON-массив — фрагмент пропущен.`,
            );
          } else {
            const parsed = outcome.value;
            parsedChunks += 1;
            if (parsed.droppedNoSource > 0) {
              this.logLine(
                job,
                'warn',
                `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): отброшено записей без source (провенанс обязателен): ${parsed.droppedNoSource}.`,
              );
            }
            if (parsed.droppedInvalid > 0) {
              this.logLine(
                job,
                'warn',
                `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): отброшено записей, не соответствующих схеме: ${parsed.droppedInvalid}.`,
              );
            }
            const fn = parsed.items.filter((r) => r.type === 'FUNCTION').length;
            const nfr = parsed.items.length - fn;
            this.logLine(
              job,
              'info',
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): извлечено ${fn} ФТ, ${nfr} НФТ.`,
            );
            extracted.push(...parsed.items);
          }
          job.progress = Math.min(65, 5 + Math.round((60 * processedChunks) / totalChunks));
        }
      }
      if (parsedChunks === 0) {
        this.fail(
          job,
          'Ни один ответ модели не удалось разобрать как структурированный JSON.',
          AI_IMPORT_HINT_UNPARSEABLE,
        );
        return;
      }

      // ── structure (65–80) ───────────────────────────────────────────────
      // Task 13 B2: one more pass over the AI hub that sees the FULL set of
      // extracted requirements and assembles the tree. Its parentName is
      // authoritative: it OVERRIDES extraction-time parentName; records
      // missing from the answer (or with parentName=null, or from a batch
      // that failed 3 attempts) stay roots. The tree is best-effort — a
      // failure here never fails the job (requirements matter more).
      job.stage = 'structure';
      if (this.cancelIfRequested(job, counters)) return;
      // First answer per (type, name): null = explicit root, string = parent.
      const structureParentByKey = new Map<string, string | null>();
      const seenKeys = new Set<string>();
      const structureItems: StructureItem[] = [];
      for (const record of extracted) {
        const key = nameKey(record.type, record.name);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        structureItems.push({ type: record.type, name: record.name, source: record.source });
      }
      if (structureItems.length === 0) {
        // Task 14 B9: nothing extracted → no hub calls, no empty batch.
        this.logLine(job, 'info', 'Структурировать нечего — требования не извлечены.');
      } else {
        this.logLine(job, 'info', 'Построение древовидной структуры ФТ/НФТ через AI hub…');
      }
      const batchSize = this.deps.structureBatch ?? AI_IMPORT_STRUCTURE_BATCH;
      const batches: StructureItem[][] = [];
      for (let i = 0; i < structureItems.length; i += batchSize) {
        batches.push(structureItems.slice(i, i + batchSize));
      }
      for (let b = 0; b < batches.length; b++) {
        if (b > 0 && this.cancelIfRequested(job, counters)) return;
        const batchLabel = `Структуризация (батч ${b + 1}/${batches.length})`;
        const outcome = await this.chatWithJsonRetries<ParsedStructure>({
          job,
          counters,
          client,
          model,
          messages: buildStructureMessages(batches[b]!, archiveMap, structureItems),
          maxTokens: AI_IMPORT_STRUCTURE_MAX_TOKENS, // Task 14 B1
          parse: (content) => parseStructureResponse(content),
          // Task 14 B7: the LAST attempt keeps valid nodes instead of losing the batch.
          parseFinal: (content) => parseStructureResponse(content, 'lenient'),
          attemptWarn: (attempt) =>
            `${batchLabel}: ответ модели не распознан как JSON-массив структуры (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
          truncatedWarn: (attempt) =>
            `${batchLabel}: ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
        });
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'ok') {
          const { nodes, droppedInvalid, total } = outcome.value;
          if (droppedInvalid > 0) {
            this.logLine(
              job,
              'warn',
              `${batchLabel}: принято ${total - droppedInvalid} из ${total} узлов, невалидных отброшено ${droppedInvalid}.`,
            );
          }
          // Task 14 B5: coverage report for the batch answer.
          const answered = new Set<string>();
          let foreign = 0;
          for (const node of nodes) {
            const key = nameKey(node.type, node.name);
            if (!seenKeys.has(key)) {
              foreign += 1; // never becomes a parent mapping
              continue;
            }
            const parent =
              node.parentName !== null && node.parentName.trim().length > 0
                ? node.parentName
                : null;
            if (structureParentByKey.has(key)) {
              if (structureParentByKey.get(key) !== parent) {
                this.logLine(
                  job,
                  'warn',
                  `${batchLabel}: конфликт узлов для «${node.name}» (${node.type}) — разные parentName, используется первый.`,
                );
              }
            } else {
              structureParentByKey.set(key, parent);
            }
            answered.add(key);
          }
          if (foreign > 0) {
            this.logLine(
              job,
              'warn',
              `${batchLabel}: посторонних узлов проигнорировано: ${foreign}.`,
            );
          }
          const missing = batches[b]!.filter(
            (item) => !answered.has(nameKey(item.type, item.name)),
          ).length;
          if (missing > 0) {
            this.logLine(
              job,
              'warn',
              `${batchLabel}: требований без узла в ответе: ${missing} (останутся корневыми).`,
            );
          }
        } else {
          if (outcome.kind === 'upstream') {
            this.logLine(
              job,
              'warn',
              sanitize(
                `${batchLabel}: ошибка обращения к AI Hub: ${outcome.error.message}.`,
                apiKey,
              ),
            );
          }
          this.logLine(
            job,
            'warn',
            'Структура для батча не получена — записи останутся корневыми.',
          );
        }
        job.progress = Math.min(80, 65 + Math.round((15 * (b + 1)) / batches.length));
      }
      job.progress = 80;

      // ── aggregate (80–85) ───────────────────────────────────────────────
      job.stage = 'aggregate';
      if (this.cancelIfRequested(job, counters)) return;
      const requirementService = this.deps.makeRequirementService(job.projectId);
      const { requirements: existing } = await requirementService.list();

      const byKey = new Map<string, AiExtractedRequirement>();
      const duplicateNames: string[] = [];
      for (const record of extracted) {
        const key = nameKey(record.type, record.name);
        const prev = byKey.get(key);
        if (prev) {
          duplicateNames.push(record.name.trim());
          // Task 15: duplicates of one NFR merge their relatedFunctions
          // (union by case-insensitive name, first formulation kept).
          const merged = unionRelatedFunctions(prev.relatedFunctions, record.relatedFunctions);
          if (merged !== prev.relatedFunctions) {
            byKey.set(key, { ...prev, relatedFunctions: merged });
          }
        } else {
          byKey.set(key, record);
        }
      }
      if (duplicateNames.length > 0) {
        // Surface silently dropped in-run duplicates (they are NOT counted in
        // skippedExisting — the aiImportResultSchema contract is stable).
        this.logLine(
          job,
          'warn',
          `Дубликатов в извлечении пропущено: ${duplicateNames.length} ` +
            `(повторы по (тип, имя): ${duplicateNames.map((n) => `«${n}»`).join(', ')}).`,
        );
      }

      const existingKeys = new Map<string, Requirement>();
      for (const req of existing) existingKeys.set(nameKey(req.type, req.name), req);

      // Task 13 B2: the parent comes from the structure stage ONLY —
      // extraction-time parentName is superseded (records not covered by a
      // structure answer stay roots). Task 14 B6: resolve parents first
      // (same-type only, with a dedicated warn for an other-type parent),
      // then deterministically break cycles BEFORE anything is written.
      const parentInfoByKey = new Map<string, { parentKey: string; parentName: string }>();
      for (const record of byKey.values()) {
        const key = nameKey(record.type, record.name);
        const parentName = structureParentByKey.get(key);
        if (!parentName) continue; // root (explicit null or not covered)
        const parentKey = nameKey(record.type, parentName);
        if (parentKey === key) continue; // self-parent
        if (byKey.has(parentKey) || existingKeys.has(parentKey)) {
          parentInfoByKey.set(key, { parentKey, parentName });
          continue;
        }
        const otherType = record.type === 'FUNCTION' ? 'NFR' : 'FUNCTION';
        const otherKey = nameKey(otherType, parentName);
        if (byKey.has(otherKey) || existingKeys.has(otherKey)) {
          this.logLine(
            job,
            'warn',
            `«${record.name}»: родитель «${parentName}» имеет другой тип — иерархия допустима только внутри одного типа; пропущена.`,
          );
        } else {
          this.logLine(
            job,
            'warn',
            `«${record.name}»: родитель «${parentName}» не найден ни в извлечённом наборе, ни в проекте — иерархия пропущена.`,
          );
        }
      }

      const parentKeyByChild = new Map<string, string>();
      for (const [key, info] of parentInfoByKey) parentKeyByChild.set(key, info.parentKey);
      for (const childKey of breakParentCycles(parentKeyByChild)) {
        const childName = byKey.get(childKey)?.name ?? childKey;
        this.logLine(job, 'warn', `Цикл разорван: «${childName}» становится корневым.`);
        parentInfoByKey.delete(childKey);
      }

      const aggregated: AggregatedRecord[] = [];
      for (const record of byKey.values()) {
        const info = parentInfoByKey.get(nameKey(record.type, record.name));
        aggregated.push({ record, parentKey: info?.parentKey, parentName: info?.parentName });
      }
      if (aggregated.length > 0) this.logLine(job, 'info', this.treeSummary(aggregated));
      this.logLine(job, 'info', `К наполнению после агрегации: ${aggregated.length} требований.`);
      job.progress = 85;

      // ── populate (85–100) ───────────────────────────────────────────────
      job.stage = 'populate';
      if (this.cancelIfRequested(job, counters)) return;
      const linkService = this.deps.makeLinkService(job.projectId);
      const slugByKey = new Map<string, string>();
      for (const req of existing) slugByKey.set(nameKey(req.type, req.name), req.slug);

      const linkCandidates: LinkCandidate[] = [];
      // Task 15: NFRs whose extraction carries relatedFunctions — resolved
      // into RELATES_TO links after the CHILD_OF pass.
      const relatesCandidates: LinkCandidate[] = [];
      let processed = 0;
      for (const item of aggregated) {
        const { record } = item;
        const key = nameKey(record.type, record.name);
        processed += 1;
        if (record.relatedFunctions?.length && record.type !== 'NFR') {
          // Guard against a hallucinated field on a FUNCTION record (Task 15):
          // the binding is only meaningful FROM an NFR.
          this.logLine(
            job,
            'warn',
            `«${record.name}» (${record.type}): relatedFunctions игнорируется — привязка допустима только от НФТ.`,
          );
        }
        const wantsRelates = record.type === 'NFR' && (record.relatedFunctions?.length ?? 0) > 0;
        const existingReq = existingKeys.get(key);
        if (existingReq) {
          counters.skippedExisting += 1;
          this.logLine(
            job,
            'warn',
            `«${record.name}» (${record.type}) уже существует в проекте — пропущено, файл не изменён.`,
          );
          // Re-run survivability: the requirement is not rewritten, but its
          // extracted CHILD_OF is still ensured below when it is missing.
          if (item.parentKey) linkCandidates.push({ item, existingLinks: existingReq.links });
          // Task 15: same completion semantics for RELATES_TO — the links
          // snapshot lets the loop below skip already-present pairs (RELATES_TO
          // is symmetric, so the NFR endpoint always carries its half).
          if (wantsRelates) relatesCandidates.push({ item, existingLinks: existingReq.links });
          continue;
        }
        if (wantsRelates) relatesCandidates.push({ item });

        const criticality = record.criticality ?? AI_IMPORT_DEFAULT_CRITICALITY;
        const defaults: string[] = [];
        if (!record.criticality) defaults.push(`критичность=${AI_IMPORT_DEFAULT_CRITICALITY}`);
        if (defaults.length > 0) {
          this.logLine(
            job,
            'warn',
            `«${record.name}»: в источнике не указано — применены умолчания: ${defaults.join(', ')}.`,
          );
        }

        try {
          // Task 13 A1/A2: `source` stays EMPTY (it is a business field —
          // the file provenance lives in the job log only) and everything
          // imported is created as already implemented, so no target
          // quarter/year (core rules.ts allows them only when
          // implemented=false).
          const created = await requirementService.create({
            type: record.type,
            name: record.name,
            criticality,
            description: record.description,
            implemented: true,
          });
          slugByKey.set(key, created.slug);
          if (item.parentKey) linkCandidates.push({ item });
          if (record.type === 'FUNCTION') counters.createdFunctions += 1;
          else counters.createdNfrs += 1;
          this.logLine(job, 'info', `Создано: «${record.name}» (${record.type}).`);
        } catch (err) {
          if (err instanceof DomainError) {
            this.logLine(
              job,
              'warn',
              `«${record.name}» не создано (${err.code}): ${err.message} ${AI_IMPORT_HINT_POPULATE}`,
            );
          } else {
            throw err;
          }
        }
        job.progress = Math.min(99, 85 + Math.round((14 * processed) / aggregated.length));
      }

      // CHILD_OF links whose parent resolved: for created records AND for
      // skipped existing ones missing their extracted link (so a re-run after
      // a crash between requirements and links completes the hierarchy).
      for (const { item, existingLinks } of linkCandidates) {
        if (!item.parentKey) continue;
        const sourceSlug = slugByKey.get(nameKey(item.record.type, item.record.name));
        const targetSlug = slugByKey.get(item.parentKey);
        if (!sourceSlug || !targetSlug) continue;
        if (existingLinks?.some((l) => l.type === 'CHILD_OF' && l.targetSlug === targetSlug)) {
          continue; // link already present — existing links are never touched
        }
        try {
          await linkService.create({ sourceSlug, type: 'CHILD_OF', targetSlug });
          counters.links += 1;
          if (existingLinks) {
            this.logLine(
              job,
              'info',
              `Достроена недостающая связь CHILD_OF: «${item.record.name}» → «${item.parentName}».`,
            );
          }
        } catch (err) {
          if (err instanceof DomainError) {
            this.logLine(
              job,
              'warn',
              `Связь CHILD_OF «${item.record.name}» → «${item.parentName}» не создана (${err.code}): ${err.message}`,
            );
          } else {
            throw err;
          }
        }
      }

      // Task 15: RELATES_TO links from an NFR to the functions it explicitly
      // constrains. Targets resolve case-insensitively through slugByKey, so
      // both functions created by THIS import and ones that already existed in
      // the project are reachable. For skipped existing NFRs the links snapshot
      // keeps re-runs idempotent: a present pair (RELATES_TO is symmetric — the
      // NFR endpoint always stores its half) is never touched or duplicated.
      for (const { item, existingLinks } of relatesCandidates) {
        const { record } = item;
        const sourceSlug = slugByKey.get(nameKey(record.type, record.name));
        if (!sourceSlug) continue; // the NFR itself failed to create
        const seenTargets = new Set<string>();
        for (const fnName of record.relatedFunctions ?? []) {
          const fnKey = nameKey('FUNCTION', fnName);
          if (seenTargets.has(fnKey)) continue; // in-record duplicate
          seenTargets.add(fnKey);
          if (this.cancelIfRequested(job, counters)) return;
          const targetSlug = slugByKey.get(fnKey);
          if (!targetSlug) {
            this.logLine(
              job,
              'warn',
              `НФТ «${record.name}»: связанная ФТ «${fnName}» не найдена — связь пропущена.`,
            );
            continue;
          }
          if (existingLinks?.some((l) => l.type === 'RELATES_TO' && l.targetSlug === targetSlug)) {
            continue; // link already present — existing links are never touched
          }
          try {
            await linkService.create({ sourceSlug, type: 'RELATES_TO', targetSlug });
            counters.relatesLinks += 1;
            this.logLine(
              job,
              'info',
              `Связано: НФТ «${record.name}» → ФТ «${fnName}» (RELATES_TO).`,
            );
          } catch (err) {
            if (err instanceof DomainError) {
              this.logLine(
                job,
                'warn',
                `Связь RELATES_TO «${record.name}» → «${fnName}» не создана (${err.code}): ${err.message}`,
              );
            } else {
              throw err;
            }
          }
        }
      }

      // ── done ────────────────────────────────────────────────────────────
      job.stage = 'done';
      job.progress = 100;
      job.result = { ...counters };
      this.logLine(
        job,
        'info',
        `Готово: создано ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}; ` +
          `пропущено существующих ${counters.skippedExisting}; связей ${counters.links}, ` +
          `связей НФТ→ФТ: ${counters.relatesLinks}.`,
      );
      this.deps.jobs.finish(job, 'succeeded');
    } finally {
      if (docsDir) await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
