import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiImportJobView } from '@po/core';
import { buildApp } from '../src/app.js';
import type { AiChatCompletionParams, AiClient } from '../src/services/AiHubService.js';
import {
  ResponseFormatNegotiator,
  buildAnalyzeResponseFormat,
  buildBacklogMatchResponseFormat,
} from '../src/services/aiImport/structuredOutput.js';
import { parseMatchResponse } from '../src/services/aiImport/backlogMatchStage.js';
import { backlogXlsxBuffer } from './aiImportKit.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/**
 * Хотфикс: бэклог-ветка (todo_22) отправляла матч-вызовы с response_format
 * СХЕМЫ АНАЛИЗА документации (items без rowId/businessName). Модель, честно
 * соблюдающая json_schema, возвращала записи без rowId → строгий
 * parseMatchResponse браковал 100% ответов → батч делился до 1 строки →
 * MODEL-01. Тесты фиксируют: (1) у матч-вызова СВОЯ схема, (2) analyze не
 * задет, (3) ответ-обёртка {"answers":[...]} парсится, (4) симптом
 * (ответ в формате analyze-схемы) не проходит строгий парсер.
 */

const SECRET = 'sk-hotfix-secret';
const PROJECT = 'Demo';

function formatError(message: string, status = 400): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

type JsonSchemaFormat = {
  type: string;
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
};

describe('hotfix · buildBacklogMatchResponseFormat', () => {
  it('строгая json_schema с корнем {"answers":[...]} и полным контрактом ответа', () => {
    const format = buildBacklogMatchResponseFormat() as JsonSchemaFormat;
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.name).not.toBe('extracted_requirements');
    expect(format.json_schema.strict).toBe(true);

    const root = format.json_schema.schema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: { answers: { type: string; items: Record<string, unknown> } };
    };
    expect(root.type).toBe('object');
    expect(root.additionalProperties).toBe(false);
    expect(root.required).toEqual(['answers']);
    expect(root.properties.answers.type).toBe('array');

    const item = root.properties.answers.items as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    // strict:true требует ВСЕ ключи в required — nullable выражен типами.
    expect(item.required).toEqual([
      'rowId',
      'businessName',
      'type',
      'parentExisting',
      'parentNew',
      'duplicateOf',
    ]);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties['rowId']).toEqual({ type: 'string' });
    expect(item.properties['businessName']).toEqual({ type: 'string' });
    expect(item.properties['type']).toEqual({ type: 'string', enum: ['FUNCTION', 'NFR'] });
    expect(item.properties['parentExisting']).toEqual({ type: ['string', 'null'] });
    expect(item.properties['duplicateOf']).toEqual({ type: ['string', 'null'] });
    // parentNew: {name, parentName:string|null} | null.
    const parentNew = JSON.stringify(item.properties['parentNew']);
    expect(parentNew).toContain('"name"');
    expect(parentNew).toContain('"parentName"');
    expect(parentNew).toContain('null');
  });
});

describe('hotfix · ResponseFormatNegotiator с кастомным билдером', () => {
  it('дефолт остаётся схемой анализа (обратная совместимость docs-ветки)', () => {
    const neg = new ResponseFormatNegotiator();
    expect(neg.responseFormat()).toEqual(buildAnalyzeResponseFormat());
  });

  it('с билдером бэклога отдаёт бэклог-схему', () => {
    const neg = new ResponseFormatNegotiator(buildBacklogMatchResponseFormat);
    const format = neg.responseFormat() as JsonSchemaFormat;
    expect(format.json_schema.name).toBe(
      (buildBacklogMatchResponseFormat() as JsonSchemaFormat).json_schema.name,
    );
  });

  it('деградация json_schema → json_object → none работает и с кастомным билдером', () => {
    const neg = new ResponseFormatNegotiator(buildBacklogMatchResponseFormat);
    expect(neg.noteRejected(formatError('response_format is not supported'))).toBe(true);
    expect(neg.mode).toBe('json_object');
    expect(neg.responseFormat()).toEqual({ type: 'json_object' });
    expect(neg.noteRejected(formatError('response_format is not supported'))).toBe(true);
    expect(neg.mode).toBe('none');
    expect(neg.responseFormat()).toBeUndefined();
  });
});

describe('hotfix · parseMatchResponse и обёртки ответа', () => {
  const IDS = new Set(['r2']);
  const VALID = {
    rowId: 'r2',
    businessName: 'Сводный отчёт',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Отчётность', parentName: null },
    duplicateOf: null,
  };

  it('строгий режим принимает объект-обёртку {"answers":[...]} (ответ по json_schema)', () => {
    const wrapped = JSON.stringify({ answers: [VALID] });
    const answers = parseMatchResponse(wrapped, IDS);
    expect(answers).toHaveLength(1);
    expect(answers![0]).toMatchObject({ rowId: 'r2', businessName: 'Сводный отчёт' });
  });

  it('строгий режим принимает ```json-обёртку вокруг {"answers":[...]}', () => {
    const fenced = '```json\n' + JSON.stringify({ answers: [VALID] }) + '\n```';
    expect(parseMatchResponse(fenced, IDS)).toHaveLength(1);
  });

  it('регрессия-симптом: ответ в формате analyze-схемы (items без rowId) бракуется строгим парсером', () => {
    const analyzeShaped = JSON.stringify({
      items: [
        {
          type: 'FUNCTION',
          name: 'Печать сводного отчёта',
          description: 'Отчёт печатается.',
          source: 'backlog',
        },
      ],
    });
    expect(parseMatchResponse(analyzeShaped, IDS)).toBeNull();
  });
});

/* ── Интеграция: реальный сервис, клиент захватывает body каждого вызова ── */

function multipart(
  fields: Record<string, string>,
  file: { filename: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----po${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Клиент, запоминающий params КАЖДОГО вызова (включая response_format). */
function captureClient(content: string): { client: AiClient; calls: AiChatCompletionParams[] } {
  const calls: AiChatCompletionParams[] = [];
  const client: AiClient = {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async (params: AiChatCompletionParams) => {
          calls.push(params);
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
  return { client, calls };
}

function schemaNames(calls: AiChatCompletionParams[]): string[] {
  return calls
    .map((c) => c.response_format as JsonSchemaFormat | undefined)
    .filter((f): f is JsonSchemaFormat => f?.type === 'json_schema')
    .map((f) => f.json_schema.name);
}

describe('hotfix · response_format по веткам импорта (интеграция)', () => {
  let root: string;
  let app: FastifyInstance;

  async function boot(client: AiClient): Promise<void> {
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      makeAiClient: () => client,
    });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: PROJECT } });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: PROJECT, model: 'Qwen-Coder-Next' },
    });
  }

  async function poll(
    jobId: string,
    until: (v: AiImportJobView) => boolean,
  ): Promise<AiImportJobView> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/ai-import/${jobId}` });
      expect(res.statusCode).toBe(200);
      const view = res.json() as AiImportJobView;
      if (until(view)) return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not reach the expected state');
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('матч-вызов бэклога несёт схему бэклога, НЕ extracted_requirements (прод-баг)', async () => {
    // Модель честно отвечает по СВОЕЙ json_schema: {"answers":[...]}.
    const answer = JSON.stringify({
      answers: [
        {
          rowId: 'r2',
          businessName: 'Сводный отчёт',
          type: 'FUNCTION',
          parentExisting: null,
          parentNew: { name: 'Отчётность', parentName: null },
          duplicateOf: null,
        },
      ],
    });
    const { client, calls } = captureClient(answer);
    await boot(client);

    const xlsx = backlogXlsxBuffer([
      ['Issue key', 'Summary'],
      ['AB-1', 'Печать сводного отчёта'],
    ]);
    const { body, contentType } = multipart({}, { filename: 'Книга2.xlsx', content: xlsx });
    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(started.statusCode).toBe(202);
    const { jobId } = started.json() as { jobId: string };

    await poll(jobId, (v) => v.status === 'awaiting-confirmation');
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/confirm`,
      payload: { targetQuarter: 'Q2', targetYear: 2027 },
    });
    expect(confirmed.statusCode).toBe(200);
    const reviewed = await poll(jobId, (v) => v.status === 'awaiting-review');
    expect(reviewed.backlogReview?.mappings).toHaveLength(1);

    const names = schemaNames(calls);
    expect(names.length).toBeGreaterThan(0);
    // Прод-баг: сюда уезжала схема анализа документации.
    expect(names).not.toContain('extracted_requirements');
    const backlogName = (buildBacklogMatchResponseFormat() as JsonSchemaFormat).json_schema.name;
    expect(new Set(names)).toEqual(new Set([backlogName]));
  });

  it('docs-ветка (analyze) не задета: вызовы несут extracted_requirements', async () => {
    const extraction = JSON.stringify([
      {
        type: 'FUNCTION',
        name: 'Вход по паролю',
        description: 'Пользователь входит по email и паролю.',
        source: 'auth.md § Вход',
      },
    ]);
    const { client, calls } = captureClient(extraction);
    await boot(client);

    const zip = new AdmZip();
    zip.addFile('auth.md', Buffer.from('# Вход\nВход по email и паролю.', 'utf8'));
    const { body, contentType } = multipart({}, { filename: 'docs.zip', content: zip.toBuffer() });
    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(started.statusCode).toBe(202);
    const { jobId } = started.json() as { jobId: string };
    const done = await poll(jobId, (v) => v.status !== 'running');
    expect(done.status).toBe('succeeded');

    const names = schemaNames(calls);
    expect(names).toContain('extracted_requirements');
    const backlogName = (buildBacklogMatchResponseFormat() as JsonSchemaFormat).json_schema.name;
    expect(names).not.toContain(backlogName);
  });
});
