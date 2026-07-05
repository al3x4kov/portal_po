import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AI_IMPORT_CHUNK_CHARS,
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_MAX_TOKENS,
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

/** Extracted records per structure-stage batch (Task 13 B2). */
export const AI_IMPORT_STRUCTURE_BATCH = 100;

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
  /** Structure batch size override for tests; production uses 100 (Task 13). */
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
        `ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}, связей ${counters.links}.`,
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
   */
  private async chatWithJsonRetries<T>(args: {
    job: AiImportJobState;
    counters: AiImportResult;
    client: AiClient;
    model: string;
    messages: AiChatMessage[];
    parse: (content: string) => T | null;
    attemptWarn: (attempt: number) => string;
  }): Promise<JsonCallOutcome<T>> {
    for (let attempt = 1; attempt <= AI_IMPORT_JSON_ATTEMPTS; attempt++) {
      let content: string;
      try {
        const res = await args.client.chat.completions.create({
          model: args.model,
          messages: args.messages,
          temperature: AI_IMPORT_TEMPERATURE,
          max_tokens: AI_IMPORT_MAX_TOKENS,
        });
        content = res.choices?.[0]?.message?.content ?? '';
      } catch (err) {
        return { kind: 'upstream', error: err as Error };
      }
      const value = args.parse(content);
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
          const outcome = await this.chatWithJsonRetries({
            job,
            counters,
            client,
            model,
            messages,
            parse: parseExtractionResponse,
            attemptWarn: (attempt) =>
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели не распознан как JSON-массив (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
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
      this.logLine(job, 'info', 'Построение древовидной структуры ФТ/НФТ через AI hub…');
      const structureParentByKey = new Map<string, string>();
      const seenKeys = new Set<string>();
      const structureItems: StructureItem[] = [];
      for (const record of extracted) {
        const key = nameKey(record.type, record.name);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        structureItems.push({ type: record.type, name: record.name });
      }
      const batchSize = this.deps.structureBatch ?? AI_IMPORT_STRUCTURE_BATCH;
      const batches: StructureItem[][] = [];
      for (let i = 0; i < structureItems.length; i += batchSize) {
        batches.push(structureItems.slice(i, i + batchSize));
      }
      for (let b = 0; b < batches.length; b++) {
        if (b > 0 && this.cancelIfRequested(job, counters)) return;
        const outcome = await this.chatWithJsonRetries({
          job,
          counters,
          client,
          model,
          messages: buildStructureMessages(batches[b]!, archiveMap),
          parse: parseStructureResponse,
          attemptWarn: (attempt) =>
            `Структуризация (батч ${b + 1}/${batches.length}): ответ модели не распознан как JSON-массив структуры (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
        });
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'ok') {
          for (const node of outcome.value) {
            if (node.parentName !== null && node.parentName.trim().length > 0) {
              structureParentByKey.set(nameKey(node.type, node.name), node.parentName);
            }
          }
        } else {
          if (outcome.kind === 'upstream') {
            this.logLine(
              job,
              'warn',
              sanitize(
                `Структуризация (батч ${b + 1}/${batches.length}): ошибка обращения к AI Hub: ${outcome.error.message}.`,
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
        if (byKey.has(key)) duplicateNames.push(record.name.trim());
        else byKey.set(key, record);
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

      const aggregated: AggregatedRecord[] = [];
      for (const record of byKey.values()) {
        // Task 13 B2: the parent comes from the structure stage ONLY —
        // extraction-time parentName is superseded (records not covered by a
        // structure answer stay roots).
        const parentName = structureParentByKey.get(nameKey(record.type, record.name));
        let parentKey: string | undefined;
        if (parentName) {
          const key = nameKey(record.type, parentName);
          if (byKey.has(key) || existingKeys.has(key)) {
            parentKey = key;
          } else {
            this.logLine(
              job,
              'warn',
              `«${record.name}»: родитель «${parentName}» не найден ни в извлечённом наборе, ни в проекте — иерархия пропущена.`,
            );
          }
        }
        if (parentKey === nameKey(record.type, record.name)) parentKey = undefined; // self-parent
        aggregated.push({ record, parentKey, parentName });
      }
      this.logLine(job, 'info', `К наполнению после агрегации: ${aggregated.length} требований.`);
      job.progress = 85;

      // ── populate (85–100) ───────────────────────────────────────────────
      job.stage = 'populate';
      if (this.cancelIfRequested(job, counters)) return;
      const linkService = this.deps.makeLinkService(job.projectId);
      const slugByKey = new Map<string, string>();
      for (const req of existing) slugByKey.set(nameKey(req.type, req.name), req.slug);

      const linkCandidates: LinkCandidate[] = [];
      let processed = 0;
      for (const item of aggregated) {
        const { record } = item;
        const key = nameKey(record.type, record.name);
        processed += 1;
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
          continue;
        }

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

      // ── done ────────────────────────────────────────────────────────────
      job.stage = 'done';
      job.progress = 100;
      job.result = { ...counters };
      this.logLine(
        job,
        'info',
        `Готово: создано ФТ ${counters.createdFunctions}, НФТ ${counters.createdNfrs}; ` +
          `пропущено существующих ${counters.skippedExisting}; связей ${counters.links}.`,
      );
      this.deps.jobs.finish(job, 'succeeded');
    } finally {
      if (docsDir) await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
