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
  type Requirement,
  type TargetQuarter,
} from '@po/core';
import type { AiConfigRepo } from '../repositories/AiConfigRepo.js';
import type { RequirementService } from './RequirementService.js';
import type { LinkService } from './LinkService.js';
import type { AiClient, AiClientFactory } from './AiHubService.js';
import type { AiImportJobs, AiImportJobState } from './AiImportJobs.js';
import type { OpLogger } from '../lib/logger.js';
import { unpackDocsArchive } from '../lib/unpack.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { buildExtractionMessages, chunkText, parseExtractionResponse } from './aiImportPrompt.js';

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

/** Max length of the requirement `source` field (core requirementSchema). */
const REQUIREMENT_SOURCE_MAX = 100;

/** Defaults applied for gaps in the source (PO decision §3.1). */
export const AI_IMPORT_DEFAULT_CRITICALITY = 'MEDIUM' as const;

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
}

/** One aggregated record plus its resolved parent (by name, same type). */
interface AggregatedRecord {
  record: AiExtractedRequirement;
  parentKey?: string;
}

/**
 * Use-case service for «AI подгрузка ФТ/НФТ из документации» (Task 11):
 * unpack → analyze (sequential chunked AI calls) → aggregate → populate.
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
      let files: string[];
      try {
        const unpacked = await unpackDocsArchive(archivePath);
        docsDir = unpacked.dir;
        files = unpacked.files;
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
      if (files.length === 0) {
        this.fail(
          job,
          'В архиве нет файлов документации (.md/.markdown/.txt).',
          AI_IMPORT_HINT_NO_DOCS,
        );
        return;
      }
      this.logLine(job, 'info', `Найдено файлов документации: ${files.length}.`);
      job.progress = 5;

      // ── analyze (5–80) ──────────────────────────────────────────────────
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

          const messages = buildExtractionMessages(chunks[i]!, file, {
            index: i + 1,
            total: chunks.length,
          });
          let content: string;
          try {
            const res = await client.chat.completions.create({
              model,
              messages,
              temperature: AI_IMPORT_TEMPERATURE,
              max_tokens: AI_IMPORT_MAX_TOKENS,
            });
            content = res.choices?.[0]?.message?.content ?? '';
          } catch (err) {
            this.fail(
              job,
              sanitize(`Ошибка обращения к AI Hub: ${(err as Error).message}`, apiKey),
              AI_IMPORT_HINT_UPSTREAM,
            );
            return;
          }

          processedChunks += 1;
          const parsed = parseExtractionResponse(content);
          if (parsed === null) {
            this.logLine(
              job,
              'warn',
              `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели не распознан как JSON-массив — фрагмент пропущен.`,
            );
          } else {
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
          job.progress = Math.min(80, 5 + Math.round((75 * processedChunks) / totalChunks));
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

      // ── aggregate (80–85) ───────────────────────────────────────────────
      job.stage = 'aggregate';
      if (this.cancelIfRequested(job, counters)) return;
      const requirementService = this.deps.makeRequirementService(job.projectId);
      const { requirements: existing } = await requirementService.list();

      const byKey = new Map<string, AiExtractedRequirement>();
      let duplicates = 0;
      for (const record of extracted) {
        const key = nameKey(record.type, record.name);
        if (byKey.has(key)) duplicates += 1;
        else byKey.set(key, record);
      }
      if (duplicates > 0) {
        this.logLine(job, 'info', `Схлопнуто дубликатов по (тип, имя): ${duplicates}.`);
      }

      const existingKeys = new Map<string, Requirement>();
      for (const req of existing) existingKeys.set(nameKey(req.type, req.name), req);

      const aggregated: AggregatedRecord[] = [];
      for (const record of byKey.values()) {
        let parentKey: string | undefined;
        if (record.parentName) {
          const key = nameKey(record.type, record.parentName);
          if (byKey.has(key) || existingKeys.has(key)) {
            parentKey = key;
          } else {
            this.logLine(
              job,
              'warn',
              `«${record.name}»: родитель «${record.parentName}» не найден ни в извлечённом наборе, ни в проекте — иерархия пропущена.`,
            );
          }
        }
        if (parentKey === nameKey(record.type, record.name)) parentKey = undefined; // self-parent
        aggregated.push({ record, parentKey });
      }
      this.logLine(job, 'info', `К наполнению после агрегации: ${aggregated.length} требований.`);
      job.progress = 85;

      // ── populate (85–100) ───────────────────────────────────────────────
      job.stage = 'populate';
      if (this.cancelIfRequested(job, counters)) return;
      const linkService = this.deps.makeLinkService(job.projectId);
      const slugByKey = new Map<string, string>();
      for (const req of existing) slugByKey.set(nameKey(req.type, req.name), req.slug);

      const createdRecords: AggregatedRecord[] = [];
      let processed = 0;
      for (const item of aggregated) {
        const { record } = item;
        const key = nameKey(record.type, record.name);
        processed += 1;
        if (existingKeys.has(key)) {
          counters.skippedExisting += 1;
          this.logLine(
            job,
            'warn',
            `«${record.name}» (${record.type}) уже существует в проекте — пропущено, файл не изменён.`,
          );
          continue;
        }

        const criticality = record.criticality ?? AI_IMPORT_DEFAULT_CRITICALITY;
        const implemented = record.implemented ?? false;
        const defaults: string[] = [];
        if (!record.criticality) defaults.push(`критичность=${AI_IMPORT_DEFAULT_CRITICALITY}`);
        if (record.implemented === undefined) defaults.push('статус=не реализовано');

        let targetQuarter: TargetQuarter | undefined;
        let targetYear: number | undefined;
        if (!implemented) {
          const next = nextQuarterOf(this.deps.now());
          targetQuarter = record.targetQuarter ?? next.targetQuarter;
          targetYear = record.targetYear ?? next.targetYear;
          if (!record.targetQuarter || record.targetYear === undefined) {
            defaults.push(`target=${targetQuarter} ${targetYear}`);
          }
        }
        if (defaults.length > 0) {
          this.logLine(
            job,
            'warn',
            `«${record.name}»: в источнике не указано — применены умолчания: ${defaults.join(', ')}.`,
          );
        }

        try {
          const created = await requirementService.create({
            type: record.type,
            name: record.name,
            criticality,
            description: record.description,
            implemented,
            targetQuarter,
            targetYear,
            source: record.source.slice(0, REQUIREMENT_SOURCE_MAX),
          });
          slugByKey.set(key, created.slug);
          createdRecords.push(item);
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

      // CHILD_OF links for the created records whose parent resolved.
      for (const item of createdRecords) {
        if (!item.parentKey) continue;
        const sourceSlug = slugByKey.get(nameKey(item.record.type, item.record.name));
        const targetSlug = slugByKey.get(item.parentKey);
        if (!sourceSlug || !targetSlug) continue;
        try {
          await linkService.create({ sourceSlug, type: 'CHILD_OF', targetSlug });
          counters.links += 1;
        } catch (err) {
          if (err instanceof DomainError) {
            this.logLine(
              job,
              'warn',
              `Связь CHILD_OF «${item.record.name}» → «${item.record.parentName}» не создана (${err.code}): ${err.message}`,
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
