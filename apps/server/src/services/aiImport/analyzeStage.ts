import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AiExtractedRequirement, AiImportSourceClass, AiModelPreset } from '@po/core';
import type { AiClient, AiClientFactory } from '../AiHubService.js';
import {
  batchFileSeparator,
  buildBatchExtractionMessages,
  buildExtractionMessages,
  parseExtractionResponse,
  type ParsedExtraction,
} from '../aiImportPrompt.js';
import type { AiChatMessage } from '../aiPrompt.js';
import {
  AI_IMPORT_HINT_NO_DOCS,
  AI_IMPORT_HINT_UNPARSEABLE,
  AI_IMPORT_HINT_UPSTREAM,
  AI_IMPORT_JSON_ATTEMPTS,
} from './constants.js';
import { sanitize } from './text.js';
import { AdaptiveChunker, type AdaptiveChunkerState } from './adaptiveChunker.js';
import type { BudgetTracker } from './budget.js';
import { EtaTracker } from './eta.js';
import { ParallelismGovernor } from './parallel.js';
import type { ReportBuilder } from './report.js';
import { fewShotForClass, type ResponseFormatNegotiator } from './structuredOutput.js';
import { normalizeForExtraction } from './normalize.js';
import type { AiCallErrorClass } from './aiCall.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

/** Resume point of the analyze stage restored from a checkpoint (T-212). */
export interface AnalyzeResume {
  /** Files before this index are fully consumed. */
  fileIndex: number;
  /** Committed chars of the NORMALIZED text of `files[fileIndex]`. */
  charOffset: number;
  /** Records extracted by the previous run(s). */
  extracted: AiExtractedRequirement[];
  processedChunks: number;
  chunker?: AdaptiveChunkerState;
}

export interface AnalyzeInput {
  docsDir: string;
  files: string[];
  archiveMap: ArchiveMap;
  model: string;
  apiKey: string;
  baseURL: string;
  preset: AiModelPreset;
  chunkChars: number;
  makeAiClient: AiClientFactory;
  /** todo_20 T-202: source class per file (few-shot + progress-with-content). */
  classes?: Map<string, AiImportSourceClass>;
  /** todo_20 T-206: per-run structured-output negotiation. */
  negotiator?: ResponseFormatNegotiator;
  /** todo_20 T-208: run token budget (soft stop with BUDGET-01). */
  budget?: BudgetTracker;
  /** todo_20 T-213: incremental quality report (coverage / blind spots). */
  report?: ReportBuilder;
  /** todo_20 T-212: continue from a checkpoint instead of scratch. */
  resume?: AnalyzeResume;
  /** Clock for the ETA extrapolation (injectable in tests). */
  nowMs?: () => number;
}

export type AnalyzeOutcome =
  { ok: true; client: AiClient; extracted: AiExtractedRequirement[] } | { ok: false };

/** Registry code of one upstream failure class exhausting its retries (T-209/T-213). */
function upstreamCodeOf(
  errorClass: AiCallErrorClass,
): 'CFG-02' | 'CFG-03' | 'NET-01' | 'NET-02' | 'NET-03' | null {
  switch (errorClass) {
    case 'auth':
      return 'CFG-02';
    case 'model-not-found':
      return 'CFG-03';
    case 'rate-limit':
      return 'NET-01';
    case 'server':
    case 'network':
      return 'NET-02';
    case 'timeout':
      return 'NET-03';
    default:
      return null;
  }
}

export { batchFileSeparator };

/** One row handed to the batching planner (todo_23 M1). */
export interface BatchPlanDoc {
  file: string;
  /** Length of the NORMALIZED text, chars. */
  length: number;
  cls?: AiImportSourceClass;
}

/**
 * todo_23 · M1: plan the work units of the analyze stage. Consecutive SMALL
 * files (each fitting into `chunkChars` with its separator) of ONE source
 * class are packed into a batched unit — one extraction call instead of one
 * call per file. Large/empty files and a partially-resumed first file keep
 * the historical one-file-per-unit behaviour. Returns contiguous index groups
 * over `docs` (позиция по описи — the checkpoint cursor stays file-based).
 */
export function planWorkUnits(
  docs: BatchPlanDoc[],
  startIndex: number,
  startOffset: number,
  chunkChars: number,
): number[][] {
  // Piece size inside a batch: separator line + newline + text + join newline.
  const pieceLen = (doc: BatchPlanDoc): number =>
    batchFileSeparator(doc.file).length + 1 + doc.length + 1;
  const units: number[][] = [];
  let i = startIndex;
  while (i < docs.length) {
    const doc = docs[i]!;
    const partialResume = i === startIndex && startOffset > 0;
    if (partialResume || doc.length === 0 || pieceLen(doc) >= chunkChars) {
      units.push([i]);
      i += 1;
      continue;
    }
    const unit = [i];
    let size = pieceLen(doc);
    let j = i + 1;
    while (j < docs.length) {
      const next = docs[j]!;
      if (next.cls !== doc.cls || next.length === 0) break;
      const nextLen = pieceLen(next);
      if (nextLen >= chunkChars || size + nextLen > chunkChars) break;
      unit.push(j);
      size += nextLen;
      j += 1;
    }
    units.push(unit);
    i = j;
  }
  return units;
}

/** Outcome of one (possibly recursively split) chunk. */
type ChunkOutcome =
  | { kind: 'items'; items: AiExtractedRequirement[]; skipped: boolean }
  | { kind: 'fatal'; fail: () => Promise<void> | void }
  | { kind: 'cancelled' };

/** Signal that stopped a file pool before its queue was drained. */
type PoolStop = 'fatal' | 'cancelled' | 'budget';

/**
 * Stage «analyze» (todo_20: progress 10–65). Reads every documentation file
 * ONCE (Н1), normalizes structured sources to flat text (T-203), chunks them
 * ADAPTIVELY (T-205) and runs the extraction calls in a pool of
 * K = `preset.parallelism` workers (T-210) with in-order commit — the merge
 * order never depends on completion order. A 429 collapses the pool to 1 with
 * gradual recovery. After every committed chunk the job checkpoint is updated
 * (T-211) so a resumed run continues at `files[fileIndex] + charOffset`
 * without re-paying processed chunks (T-212). A file whose extraction found
 * less than half of the visible records (T-203 density) gets ONE repeat pass
 * («извлеки ВСЕ, найдено N из ~M», T-207 B5). Coverage/blind spots accumulate
 * into the report (T-213); ETA appears after the first committed chunks.
 */
export async function runAnalyzeStage(
  rt: AiImportRuntime,
  input: AnalyzeInput,
): Promise<AnalyzeOutcome> {
  const { job } = rt;
  job.stage = 'analyze';
  const nowMs = input.nowMs ?? Date.now;
  const progressBase = Math.max(job.progress, 5);
  rt.log('info', 'Чтение и подготовка файлов документации…');
  const chunker = input.resume?.chunker
    ? AdaptiveChunker.fromJSON(input.resume.chunker)
    : new AdaptiveChunker({ initialChars: input.chunkChars });
  const governor = new ParallelismGovernor(input.preset.parallelism);

  const startFileIndex = input.resume?.fileIndex ?? 0;
  const startOffset = input.resume?.charOffset ?? 0;
  const docs: Array<{ file: string; text: string; expectedRecords: number | null }> = [];
  for (const file of input.files) {
    const raw = await fs.readFile(path.join(input.docsDir, file), 'utf8');
    // T-203: format-aware normalization (JSON/MD-tables/YAML → flat lines);
    // plain text passes through verbatim, broken structures never throw.
    const normalized = normalizeForExtraction(raw);
    if (normalized.format !== 'plain') {
      rt.log(
        'info',
        `Файл ${file}: структура ${normalized.format} нормализована` +
          (normalized.expectedRecords !== null
            ? ` (~${normalized.expectedRecords} записей).`
            : '.'),
      );
    }
    docs.push({ file, text: normalized.text, expectedRecords: normalized.expectedRecords });
  }

  // todo_23 M1: consecutive small files of ONE class are packed into batched
  // units (one extraction call each); large files keep per-file chunking. The
  // checkpoint cursor stays file-based, so units re-derive deterministically
  // on resume (позиция по описи).
  const units = planWorkUnits(
    docs.map((d) => ({ file: d.file, length: d.text.length, cls: input.classes?.get(d.file) })),
    startFileIndex,
    startOffset,
    input.chunkChars,
  );
  const unitTextOf = (unit: number[]): string =>
    unit.length === 1
      ? docs[unit[0]!]!.text
      : unit.map((idx) => `${batchFileSeparator(docs[idx]!.file)}\n${docs[idx]!.text}`).join('\n');

  // Remaining work only: a resumed run counts what is left, not what was paid.
  let totalChunks = 0;
  for (const unit of units) {
    const offset = unit.length === 1 && unit[0] === startFileIndex ? startOffset : 0;
    const remainder = unitTextOf(unit).slice(offset);
    if (remainder.length > 0) totalChunks += chunker.split(remainder).length;
  }
  if (totalChunks === 0 && input.resume === undefined) {
    rt.failCode('DATA-01', {
      message: 'Файлы документации пусты — извлекать нечего.',
      hint: AI_IMPORT_HINT_NO_DOCS,
    });
    return { ok: false };
  }
  rt.log(
    'info',
    `Модель: ${input.model}. Файлов: ${input.files.length}, фрагментов: ${totalChunks}` +
      (input.resume ? ` (продолжение — уже обработано ${input.resume.processedChunks})` : '') +
      `. Параллельных вызовов: до ${governor.limit()}.`,
  );

  const client: AiClient = input.makeAiClient(input.apiKey, input.baseURL);
  const extracted: AiExtractedRequirement[] = [...(input.resume?.extracted ?? [])];
  const eta = new EtaTracker(totalChunks);
  job.etaSeconds = job.etaSeconds ?? null;
  let processedChunks = 0;
  let parsedChunks = input.resume ? input.resume.processedChunks : 0;
  // Boxed so assignments inside the pool callbacks survive TS narrowing.
  const fatal: { fail?: () => Promise<void> | void } = {};

  /** One extraction call over one chunk; splits recursively on overload. */
  const processChunk = async (ctx: {
    file: string;
    cls: AiImportSourceClass | undefined;
    fewShot: AiChatMessage[];
    chunk: string;
    index: number;
    total: number;
    label: () => string;
    /** todo_23 M1: file paths of a batched unit (batch prompt + provenance). */
    batchFiles?: string[];
    extra?: AiChatMessage;
  }): Promise<ChunkOutcome> => {
    const base = ctx.batchFiles
      ? buildBatchExtractionMessages(
          ctx.chunk,
          ctx.batchFiles,
          { index: ctx.index, total: ctx.total },
          input.archiveMap,
        )
      : buildExtractionMessages(
          ctx.chunk,
          ctx.file,
          { index: ctx.index, total: ctx.total },
          input.archiveMap,
        );
    let messages =
      ctx.fewShot.length > 0 ? [base[0]!, ...ctx.fewShot, ...base.slice(1)] : [...base];
    if (ctx.extra) messages = [...messages, ctx.extra];
    const outcome = await rt.chat<ParsedExtraction>({
      client,
      model: input.model,
      preset: input.preset,
      messages,
      negotiator: input.negotiator,
      // T-210: the FIRST 429 (even a recovered one) collapses the pool.
      // todo_23 M4: a per-call timeout is the same overload signal — collapse
      // too, so a struggling upstream is not hammered with K parallel calls.
      onUpstreamRetry: (errorClass) => {
        if (
          (errorClass === 'rate-limit' || errorClass === 'timeout') &&
          governor.noteRateLimited()
        ) {
          rt.log(
            'warn',
            errorClass === 'rate-limit'
              ? 'Получен ответ 429 — параллелизм снижен до 1; после серии успешных фрагментов вернусь к настройке.'
              : 'Тайм-аут вызова — параллелизм снижен до 1; после серии успешных фрагментов вернусь к настройке.',
          );
        }
      },
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
        `Файл ${ctx.file} (${ctx.label()}): ответ модели не распознан как JSON-массив (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: (attempt) => {
        input.report?.noteTruncated();
        return `Файл ${ctx.file} (${ctx.label()}): ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`;
      },
    });
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };

    const splitAndRecurse = async (why: string): Promise<ChunkOutcome> => {
      const parts = chunker.split(ctx.chunk);
      rt.log(
        'warn',
        `Файл ${ctx.file}: ${why} — делю фрагмент на части по ~${chunker.chunkSize()} символов и повторяю.`,
      );
      const merged: AiExtractedRequirement[] = [];
      let skipped = false;
      for (const part of parts) {
        const sub = await processChunk({ ...ctx, chunk: part });
        if (sub.kind !== 'items') return sub;
        merged.push(...sub.items);
        skipped = skipped || sub.skipped;
      }
      return { kind: 'items', items: merged, skipped };
    };

    if (outcome.kind === 'upstream') {
      // T-205/приёмка №4: a context-window rejection is a CHUNKER signal —
      // halve and retry the same content; at the minimum it becomes MODEL-02.
      if (outcome.errorClass === 'context-length') {
        const halved = chunker.noteContextLength();
        if (halved.halved && ctx.chunk.length > chunker.chunkSize()) {
          return splitAndRecurse('фрагмент не поместился в контекстное окно модели');
        }
        return { kind: 'fatal', fail: () => rt.failCode('MODEL-02') };
      }
      const code = upstreamCodeOf(outcome.errorClass);
      return {
        kind: 'fatal',
        fail: async () => {
          rt.log(
            'error',
            sanitize(
              `Файл ${ctx.file} (${ctx.label()}): ошибка обращения к AI Hub: ${outcome.error.message}`,
              input.apiKey,
            ),
          );
          if (code === 'CFG-03') {
            // Actionable extra (П4.1): the model list when the API offers it.
            try {
              const models = await client.models.list();
              const ids = models.data.map((m) => m.id).slice(0, 20);
              if (ids.length > 0) rt.log('info', `Доступные модели: ${ids.join(', ')}.`);
            } catch {
              /* best-effort only */
            }
          }
          if (code) {
            rt.failCode(code);
          } else {
            // T-213: even an unclassifiable upstream failure carries a code;
            // the historical readable message (with sanitized detail) stays.
            rt.failCode('NET-02', {
              message: sanitize(
                `Ошибка обращения к AI Hub: ${outcome.error.message}`,
                input.apiKey,
              ),
              hint: AI_IMPORT_HINT_UPSTREAM,
            });
          }
        },
      };
    }

    if (outcome.kind === 'unparsed') {
      // T-205: two unparsable answers in a row halve the chunk; when the
      // CURRENT chunk is bigger than the new size, retry it in halves
      // instead of dropping the content.
      const halved = chunker.noteInvalidJson();
      if (halved.halved && ctx.chunk.length > chunker.chunkSize()) {
        return splitAndRecurse('два нераспознанных ответа подряд');
      }
      rt.log(
        'warn',
        `Файл ${ctx.file} (${ctx.label()}): ответ модели не распознан как JSON-массив — фрагмент пропущен.`,
      );
      input.report?.noteSkippedChunk();
      return { kind: 'items', items: [], skipped: true };
    }

    const parsed = outcome.value;
    chunker.noteSuccess();
    // todo_23 M4: every change of the effective K is visible in the log.
    if (governor.noteSuccess()) {
      rt.log(
        'info',
        `Параллелизм восстановлен до ${governor.limit()} из ${governor.presetLimit()} после серии успешных фрагментов.`,
      );
    }
    if (parsed.droppedNoSource > 0) {
      rt.log(
        'warn',
        `Файл ${ctx.file} (${ctx.label()}): отброшено записей без source (провенанс обязателен): ${parsed.droppedNoSource}.`,
      );
    }
    if (parsed.droppedInvalid > 0) {
      rt.log(
        'warn',
        `Файл ${ctx.file} (${ctx.label()}): отброшено записей, не соответствующих схеме: ${parsed.droppedInvalid}.`,
      );
    }
    return { kind: 'items', items: parsed.items, skipped: false };
  };

  /**
   * Process the chunks of one file with the parallel pool. Commit is strictly
   * in chunk order: results wait in `results[]` until every earlier chunk has
   * been committed, so `onCommit` (extraction merge, cursor, checkpoint) sees
   * a deterministic order regardless of completion order (T-210).
   */
  const runFilePool = (ctx: {
    file: string;
    cls: AiImportSourceClass | undefined;
    fewShot: AiChatMessage[];
    chunks: string[];
    /** todo_23 M1: file count of a batched unit (labels «фрагмент X из Y (N файлов)»). */
    fileCount?: number;
    /** todo_23 M1: file paths of a batched unit (batch prompt + provenance). */
    batchFiles?: string[];
    extra?: AiChatMessage;
    onCommit: (chunkIndex: number, chunkText: string, items: AiExtractedRequirement[]) => void;
  }): Promise<PoolStop | null> => {
    const { chunks } = ctx;
    const chunkLabel = (index: number): string =>
      ctx.fileCount !== undefined
        ? `фрагмент ${index + 1} из ${chunks.length} (${ctx.fileCount} файлов)`
        : `фрагмент ${index + 1}/${chunks.length}`;
    return new Promise((resolve) => {
      const results: (ChunkOutcome | undefined)[] = new Array<ChunkOutcome | undefined>(
        chunks.length,
      );
      let nextStart = 0;
      let nextCommit = 0;
      let active = 0;
      let stop: PoolStop | null = null;

      const commitReady = (): void => {
        while (nextCommit < chunks.length) {
          const ready = results[nextCommit];
          if (ready === undefined || ready.kind !== 'items') break;
          const index = nextCommit;
          nextCommit += 1;
          processedChunks += 1;
          if (!ready.skipped) parsedChunks += 1;
          eta.noteDone();
          job.etaSeconds = eta.etaSeconds(nowMs());
          job.currentFile = ctx.file;
          job.currentClass = ctx.cls;
          job.chunkIndex = index + 1;
          job.chunkTotal = chunks.length;
          const fn = ready.items.filter((r) => r.type === 'FUNCTION').length;
          const nfr = ready.items.length - fn;
          // todo_23 M3: честные счётчики — «извлечено, но ещё не записано»
          // копятся по ходу analyze и видны в прогрессе/результате.
          rt.counters.extractedFunctions = (rt.counters.extractedFunctions ?? 0) + fn;
          rt.counters.extractedNfrs = (rt.counters.extractedNfrs ?? 0) + nfr;
          job.extractedFunctions = rt.counters.extractedFunctions;
          job.extractedNfrs = rt.counters.extractedNfrs;
          if (ready.items.length > 0 || !ready.skipped) {
            rt.log(
              'info',
              `Файл ${ctx.file} (${chunkLabel(index)}): извлечено ${fn} ФТ, ${nfr} НФТ.`,
            );
            if (ctx.cls) input.report?.noteExtracted(ctx.cls, fn, nfr);
          }
          ctx.onCommit(index, chunks[index]!, ready.items);
          job.progress = Math.min(
            65,
            progressBase +
              Math.round((65 - progressBase) * (processedChunks / Math.max(1, totalChunks))),
          );
          if (input.budget?.exceeded()) stop = stop ?? 'budget';
        }
      };

      const pump = (): void => {
        if (stop === null && rt.job.cancelRequested) stop = 'cancelled';
        while (stop === null && active < governor.limit() && nextStart < chunks.length) {
          const index = nextStart;
          nextStart += 1;
          active += 1;
          eta.start(nowMs());
          // todo_16 Ф3: a pre-call line BEFORE the (long) AI request.
          rt.log('info', `Файл ${ctx.file} (${chunkLabel(index)}): запрос к модели…`);
          job.currentFile = ctx.file;
          job.currentClass = ctx.cls;
          job.chunkIndex = index + 1;
          job.chunkTotal = chunks.length;
          const processChunkPromise = processChunk({
            file: ctx.file,
            cls: ctx.cls,
            fewShot: ctx.fewShot,
            chunk: chunks[index]!,
            index: index + 1,
            total: chunks.length,
            label: () => chunkLabel(index),
            batchFiles: ctx.batchFiles,
            extra: ctx.extra,
          });
          const onInternal = (err: unknown): void => {
            stop = stop ?? 'fatal';
            const raw = err instanceof Error ? err.message : String(err);
            fatal.fail =
              fatal.fail ??
              (() => {
                rt.log('error', sanitize(`Внутренняя ошибка стадии анализа: ${raw}`, input.apiKey));
                rt.failCode('INT-01');
              });
          };
          void processChunkPromise.then(
            (outcome) => {
              active -= 1;
              try {
                if (outcome.kind === 'cancelled') {
                  stop = stop ?? 'cancelled';
                } else if (outcome.kind === 'fatal') {
                  stop = stop ?? 'fatal';
                  fatal.fail = fatal.fail ?? outcome.fail;
                } else {
                  results[index] = outcome;
                  commitReady();
                }
              } catch (err) {
                onInternal(err);
              }
              pump();
            },
            (err: unknown) => {
              active -= 1;
              onInternal(err);
              pump();
            },
          );
        }
        if (active === 0 && (stop !== null || nextStart >= chunks.length)) {
          // Commit whatever is ready before resolving (budget stop mid-queue).
          commitReady();
          resolve(stop);
        }
      };
      pump();
    });
  };

  for (const unit of units) {
    if (rt.cancelled()) return { ok: false };
    const fi = unit[0]!;
    const lastFi = unit[unit.length - 1]!;
    const isBatch = unit.length > 1;
    const { file, expectedRecords } = docs[fi]!;
    const fullText = unitTextOf(unit);
    const offset = !isBatch && fi === startFileIndex ? Math.min(startOffset, fullText.length) : 0;
    const cls = input.classes?.get(file);
    const fewShot = cls ? fewShotForClass(cls) : [];
    const displayFile = isBatch ? `${file} (+ещё ${unit.length - 1})` : file;
    const batchFiles = isBatch ? unit.map((idx) => docs[idx]!.file) : undefined;
    const fileCount = isBatch ? unit.length : undefined;
    let consumed = 0;
    let unitCommitted = 0;
    const unitItems: AiExtractedRequirement[] = [];

    const remainder = fullText.slice(offset);
    if (remainder.length > 0) {
      const chunks = chunker.split(remainder);
      const stop = await runFilePool({
        file: displayFile,
        cls,
        fewShot,
        chunks,
        fileCount,
        batchFiles,
        onCommit: (_index, chunkText, items) => {
          extracted.push(...items);
          unitItems.push(...items);
          consumed += chunkText.length;
          unitCommitted += 1;
          // todo_23 M1: a mid-batch position cannot be expressed by the
          // file-based cursor — a batched unit checkpoints once, after the
          // whole unit (usually a single call), instead of per chunk.
          if (!isBatch) {
            rt.checkpoint((state) => {
              state.chunker = chunker.toJSON();
              if (state.analyze) {
                state.analyze.fileIndex = fi;
                state.analyze.charOffset = offset + consumed;
                state.analyze.processedChunks += 1;
                state.analyze.totalChunks = totalChunks;
                state.analyze.extracted = [...extracted];
              }
            });
          }
        },
      });
      if (stop === 'cancelled') {
        rt.cancelled(); // finishes the job as cancelled (idempotent)
        return { ok: false };
      }
      if (stop === 'fatal') {
        job.result = { ...rt.counters };
        await fatal.fail?.();
        return { ok: false };
      }
      if (stop === 'budget') {
        job.result = { ...rt.counters };
        rt.log(
          'warn',
          `Бюджет прогона исчерпан (потрачено ~${input.budget?.totalTokens() ?? 0} токенов) — анализ мягко остановлен.`,
        );
        rt.failCode('BUDGET-01');
        return { ok: false };
      }
    }

    // T-207 B5 + todo_23 M2: completeness control — ONLY for release-notes
    // («видимые записи» md-таблиц/JSON других классов ≠ требования), at most
    // ONE repeat pass per unit and only when the WHOLE unit was processed in
    // this run (offset 0).
    const expectedSum = isBatch
      ? unit.reduce((sum, idx) => sum + (docs[idx]!.expectedRecords ?? 0), 0) || null
      : expectedRecords;
    if (
      offset === 0 &&
      cls === 'release-notes' &&
      expectedSum !== null &&
      expectedSum > 0 &&
      unitItems.length < expectedSum / 2
    ) {
      rt.log(
        'warn',
        `Файл ${displayFile}: извлечено ${unitItems.length} из ~${expectedSum} видимых записей — повторный проход с требованием извлечь ВСЕ записи.`,
      );
      const repeatChunks = chunker.split(fullText);
      eta.addChunks(repeatChunks.length);
      totalChunks += repeatChunks.length;
      if (cls) input.report?.noteRetriedChunks(cls, repeatChunks.length);
      const extra: AiChatMessage = {
        role: 'user',
        content:
          `В этом документе видно примерно ${expectedSum} записей, а в прошлый раз найдено ${unitItems.length}. ` +
          'Извлеки ВСЕ записи фрагмента без пропусков — по одному требованию на запись.',
      };
      const stop = await runFilePool({
        file: displayFile,
        cls,
        fewShot,
        chunks: repeatChunks,
        fileCount,
        batchFiles,
        extra,
        onCommit: (_index, _chunkText, items) => {
          extracted.push(...items);
          unitCommitted += 1;
          if (!isBatch) {
            rt.checkpoint((state) => {
              state.chunker = chunker.toJSON();
              if (state.analyze) {
                state.analyze.processedChunks += 1;
                state.analyze.extracted = [...extracted];
              }
            });
          }
        },
      });
      if (stop === 'cancelled') {
        rt.cancelled();
        return { ok: false };
      }
      if (stop === 'fatal') {
        job.result = { ...rt.counters };
        await fatal.fail?.();
        return { ok: false };
      }
      if (stop === 'budget') {
        job.result = { ...rt.counters };
        rt.log(
          'warn',
          `Бюджет прогона исчерпан (потрачено ~${input.budget?.totalTokens() ?? 0} токенов) — анализ мягко остановлен.`,
        );
        rt.failCode('BUDGET-01');
        return { ok: false };
      }
    }

    for (const idx of unit) {
      const fileCls = input.classes?.get(docs[idx]!.file);
      if (fileCls) input.report?.noteFileProcessed(fileCls);
    }
    if (input.report) job.report = input.report.view();
    // The unit is fully consumed — advance the cursor past all its files.
    rt.checkpoint((state) => {
      state.chunker = chunker.toJSON();
      if (state.analyze) {
        state.analyze.fileIndex = lastFi + 1;
        state.analyze.charOffset = 0;
        if (isBatch) {
          state.analyze.processedChunks += unitCommitted;
          state.analyze.totalChunks = totalChunks;
        }
        state.analyze.extracted = [...extracted];
      }
    });
  }

  if (parsedChunks === 0) {
    rt.failCode('MODEL-01', {
      message: 'Ни один ответ модели не удалось разобрать как структурированный JSON.',
      hint: AI_IMPORT_HINT_UNPARSEABLE,
    });
    return { ok: false };
  }
  return { ok: true, client, extracted };
}
