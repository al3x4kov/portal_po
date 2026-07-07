import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AiExtractedRequirement, AiModelPreset } from '@po/core';
import type { AiClient, AiClientFactory } from '../AiHubService.js';
import {
  buildExtractionMessages,
  chunkText,
  parseExtractionResponse,
  type ParsedExtraction,
} from '../aiImportPrompt.js';
import {
  AI_IMPORT_HINT_NO_DOCS,
  AI_IMPORT_HINT_UNPARSEABLE,
  AI_IMPORT_HINT_UPSTREAM,
  AI_IMPORT_JSON_ATTEMPTS,
} from './constants.js';
import { sanitize } from './text.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

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
}

export type AnalyzeOutcome =
  { ok: true; client: AiClient; extracted: AiExtractedRequirement[] } | { ok: false };

/**
 * Stage «analyze» (progress 5–65). Reads and chunks every documentation file,
 * then runs one AI-hub extraction call per chunk (up to 3 JSON attempts each).
 * Creates the AI client (only when there is something to analyze) and returns
 * it for the later structure/relate stages. Fails the job on an empty corpus,
 * an upstream error, or when not a single answer parsed.
 */
export async function runAnalyzeStage(
  rt: AiImportRuntime,
  input: AnalyzeInput,
): Promise<AnalyzeOutcome> {
  const { job } = rt;
  job.stage = 'analyze';
  // todo_16 Ф2: reading/chunking many files is not instant — say so.
  rt.log('info', 'Чтение и подготовка файлов документации…');
  const chunksByFile: Array<{ file: string; chunks: string[] }> = [];
  let totalChunks = 0;
  for (const file of input.files) {
    const text = await fs.readFile(path.join(input.docsDir, file), 'utf8');
    const chunks = chunkText(text, input.chunkChars);
    chunksByFile.push({ file, chunks });
    totalChunks += chunks.length;
  }
  if (totalChunks === 0) {
    rt.fail('Файлы документации пусты — извлекать нечего.', AI_IMPORT_HINT_NO_DOCS);
    return { ok: false };
  }
  // Task 14 B9: volume of the upcoming work, before the first AI call.
  rt.log(
    'info',
    `Модель: ${input.model}. Файлов: ${input.files.length}, фрагментов: ${totalChunks}.`,
  );

  const client: AiClient = input.makeAiClient(input.apiKey, input.baseURL);
  const extracted: AiExtractedRequirement[] = [];
  let processedChunks = 0;
  let parsedChunks = 0;
  for (const { file, chunks } of chunksByFile) {
    for (let i = 0; i < chunks.length; i++) {
      if (rt.cancelled()) return { ok: false };

      // todo_16 Ф3: a pre-call line BEFORE the (long) AI request, so the
      // user always sees what the pipeline is waiting for right now.
      rt.log('info', `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): запрос к модели…`);
      const messages = buildExtractionMessages(
        chunks[i]!,
        file,
        { index: i + 1, total: chunks.length },
        input.archiveMap,
      );
      // Task 13 A3: up to 3 attempts while the answer is not a JSON array;
      // upstream errors are NOT retried and fail the job as before.
      // Task 14 B8: an array whose records are ALL invalid is a format
      // failure too — retried like non-JSON. A truly empty [] is a valid
      // «no requirements here» answer and is never retried.
      const outcome = await rt.chat<ParsedExtraction>({
        client,
        model: input.model,
        preset: input.preset,
        messages,
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
      if (outcome.kind === 'cancelled') return { ok: false };
      if (outcome.kind === 'upstream') {
        rt.fail(
          sanitize(`Ошибка обращения к AI Hub: ${outcome.error.message}`, input.apiKey),
          AI_IMPORT_HINT_UPSTREAM,
        );
        return { ok: false };
      }

      processedChunks += 1;
      if (outcome.kind === 'unparsed') {
        rt.log(
          'warn',
          `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): ответ модели не распознан как JSON-массив — фрагмент пропущен.`,
        );
      } else {
        const parsed = outcome.value;
        parsedChunks += 1;
        if (parsed.droppedNoSource > 0) {
          rt.log(
            'warn',
            `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): отброшено записей без source (провенанс обязателен): ${parsed.droppedNoSource}.`,
          );
        }
        if (parsed.droppedInvalid > 0) {
          rt.log(
            'warn',
            `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): отброшено записей, не соответствующих схеме: ${parsed.droppedInvalid}.`,
          );
        }
        const fn = parsed.items.filter((r) => r.type === 'FUNCTION').length;
        const nfr = parsed.items.length - fn;
        rt.log(
          'info',
          `Файл ${file} (фрагмент ${i + 1}/${chunks.length}): извлечено ${fn} ФТ, ${nfr} НФТ.`,
        );
        extracted.push(...parsed.items);
      }
      job.progress = Math.min(65, 5 + Math.round((60 * processedChunks) / totalChunks));
    }
  }
  if (parsedChunks === 0) {
    rt.fail(
      'Ни один ответ модели не удалось разобрать как структурированный JSON.',
      AI_IMPORT_HINT_UNPARSEABLE,
    );
    return { ok: false };
  }
  return { ok: true, client, extracted };
}
