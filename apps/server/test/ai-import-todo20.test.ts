import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService, type AiImportServiceDeps } from '../src/services/AiImportService.js';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/*
 * todo_20 · волна 1.1 — интеграция стадий в AiImportService:
 * inventory/estimate в job view (T-202/T-204-заготовка), usage и бюджет
 * (T-208), классифицированные upstream-ошибки с кодами реестра и ретраями
 * (T-209), адаптивное деление чанка на context_length (T-205), деградация
 * structured output (T-206).
 */

const SECRET = 'sk-todo20-secret';
const PROJECT = 'Demo';
const MODEL = 'Qwen-Coder-Next';

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Аутентификация',
    description: 'Пользователь входит в систему.',
    source: 'auth.md § Вход',
  },
]);
const STRUCTURE = JSON.stringify([{ type: 'FUNCTION', name: 'Аутентификация', parentName: null }]);

type Answer =
  | string
  | Error
  | (() => string | Error)
  | { content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

function httpError(status: number, message = `HTTP ${status}`, headers?: Record<string, string>) {
  const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

/** Scripted client: each call consumes the next answer (last one repeats). */
function scriptedClient(answers: Answer[]): AiClient {
  let call = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] })) },
    chat: {
      completions: {
        create: vi.fn(async () => {
          const raw = answers[Math.min(call, answers.length - 1)]!;
          call += 1;
          const resolved = typeof raw === 'function' ? raw() : raw;
          if (resolved instanceof Error) throw resolved;
          if (typeof resolved === 'string') {
            return { choices: [{ message: { content: resolved } }] };
          }
          return {
            choices: [{ message: { content: resolved.content } }],
            usage: resolved.usage,
          };
        }),
      },
    },
  };
}

describe('todo_20 · AiImportService (волна 1.1)', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;
  const archives: string[] = [];

  function makeService(
    client: AiClient,
    overrides: Partial<AiImportServiceDeps> = {},
  ): AiImportService {
    const projectRepo = createProjectRepo(ctx);
    return new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
      sleep: async () => {}, // instant backoff in tests
      random: () => 0,
      ...overrides,
    });
  }

  async function writeZip(files: Record<string, string>): Promise<string> {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
      zip.addFile(name, Buffer.from(content, 'utf8'));
    }
    const file = path.join(os.tmpdir(), `po-todo20-${randomBytes(8).toString('hex')}.zip`);
    await fs.writeFile(file, zip.toBuffer());
    archives.push(file);
    return file;
  }

  async function runToEnd(service: AiImportService, archive: string): Promise<string> {
    const { jobId } = await service.start(PROJECT, archive);
    await service.waitForCompletion(jobId);
    return jobId;
  }

  async function setPreset(override: Record<string, unknown>): Promise<void> {
    await configRepo.update({ modelPresets: { [MODEL]: override } });
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    ctx = { projectsRoot: root, now: fixedNow };
    await createProjectService(ctx).create(PROJECT);
    configRepo = new AiConfigRepo(root);
    await configRepo.update({ apiKey: SECRET, projectId: PROJECT, model: MODEL });
    jobs = new AiImportJobs(fixedNow);
  });
  afterEach(async () => {
    await Promise.all(archives.splice(0).map((f) => fs.rm(f, { force: true }).catch(() => {})));
    await cleanup(root);
  });

  it('T-202/T-204: job view успешного прогона содержит опись и смету', async () => {
    const service = makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход по паролю.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.inventory).toBeDefined();
    expect(view.inventory?.totalFiles).toBe(1);
    expect(Object.values(view.inventory?.processed ?? {}).reduce((a, b) => a + b, 0)).toBe(1);
    expect(view.estimate).toBeDefined();
    expect(view.estimate?.files).toBe(1);
    expect(view.estimate?.chunks).toBeGreaterThanOrEqual(1);
    // Порог по умолчанию 2 млн — маленький архив ниже порога, гейта нет.
    expect(view.estimate?.thresholdTokens).toBe(2_000_000);
    expect(view.estimate?.overThreshold).toBe(false);
    expect(view.log.some((l) => l.message.includes('Опись'))).toBe(true);
    expect(view.log.some((l) => l.message.includes('Смета'))).toBe(true);
  });

  it('C4: usage из ответов копится и виден в view', async () => {
    const service = makeService(
      scriptedClient([
        { content: EXTRACTION, usage: { prompt_tokens: 120, completion_tokens: 40 } },
        { content: STRUCTURE, usage: { prompt_tokens: 60, completion_tokens: 10 } },
      ]),
    );
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.usage).toEqual({ promptTokens: 180, completionTokens: 50 });
  });

  it('T-208: бюджет прогона исчерпан → мягкая остановка BUDGET-01 (resumable)', async () => {
    await setPreset({ runBudgetTokens: 100 });
    const answers: Answer[] = [
      { content: EXTRACTION, usage: { prompt_tokens: 300, completion_tokens: 50 } },
    ];
    const service = makeService(scriptedClient(answers), { chunkChars: 40 });
    const jobId = await runToEnd(
      service,
      await writeZip({
        'big.md': Array.from({ length: 6 }, (_, i) => `строка ${i} ${'x'.repeat(30)}`).join('\n'),
      }),
    );

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('BUDGET-01');
    expect(view.error?.category).toBe('budget');
    expect(view.error?.resumable).toBe(true);
    expect(view.error?.message).toMatch(/[а-яё]/i);
    // Частичный результат зафиксирован, человеческое сообщение в логе.
    expect(view.result).toBeDefined();
    expect(view.log.some((l) => l.message.includes('Бюджет прогона исчерпан'))).toBe(true);
  });

  it('T-209: 401 → немедленный CFG-02 без ретраев', async () => {
    const client = scriptedClient([httpError(401, 'invalid api key')]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('CFG-02');
    expect(view.error?.category).toBe('config');
    expect(view.error?.action).toContain('ключ');
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('T-209: 404 модели → CFG-03 + список доступных моделей в логе', async () => {
    const client = scriptedClient([httpError(404, 'model not found')]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.error?.code).toBe('CFG-03');
    expect(view.log.some((l) => l.message.includes('model-a'))).toBe(true);
  });

  it('T-209: устойчивый 429 исчерпывает ретраи → NET-01, ретраи видны в логе по-русски', async () => {
    const client = scriptedClient([httpError(429, 'rate limited')]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('NET-01');
    expect(view.error?.resumable).toBe(true);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create.mock.calls.length).toBe(6); // AI_UPSTREAM_MAX_ATTEMPTS
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('Повтор запроса к модели')),
    ).toBe(true);
  });

  it('T-209: временные 5xx перекрываются ретраями — прогон доходит до конца сам', async () => {
    const client = scriptedClient([
      httpError(500, 'boom'),
      httpError(503, 'still boom'),
      EXTRACTION,
      STRUCTURE,
    ]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    expect(service.getView(jobId).status).toBe('succeeded');
  });

  it('T-209/пилот-3: зависший вызов обрывается по тайм-ауту и уходит в ретрай', async () => {
    let calls = 0;
    const client: AiClient = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
            calls += 1;
            if (calls === 1) {
              return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }) as never;
            }
            return Promise.resolve({
              choices: [{ message: { content: calls === 2 ? EXTRACTION : STRUCTURE } }],
            }) as never;
          }),
        },
      },
    };
    const service = makeService(client, { callTimeoutMs: 50 });
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.message.includes('тайм-аут'))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('T-205/приёмка №4: context_length → деление фрагмента, прогон продолжается (warn по-русски)', async () => {
    // Первый вызов извлечения падает контекстом; после деления оба под-фрагмента
    // отвечают валидно.
    const answers: Answer[] = [
      httpError(400, "This model's maximum context length is 100 tokens"),
      EXTRACTION,
      '[]',
      STRUCTURE,
    ];
    const client = scriptedClient(answers);
    // 6000 символов — выше минимума 2000, есть куда делить. Заголовок делает
    // файл классифицируемым эвристикой (release-notes), чтобы опись не тратила
    // scripted-ответы на LLM-классификацию.
    const text =
      '# Что нового\n' +
      Array.from({ length: 120 }, (_, i) => `строка ${i} ${'а'.repeat(40)}`).join('\n');
    const service = makeService(client, { chunkChars: 6000 });
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': text }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('контекстное окно'))).toBe(
      true,
    );
  });

  it('T-205: context_length на минимальном фрагменте → MODEL-02, без бесконечного цикла', async () => {
    const client = scriptedClient([httpError(400, 'context_length_exceeded')]);
    // chunkChars 40 → минимум равен 40 → делить некуда.
    const service = makeService(client, { chunkChars: 40 });
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход по паролю.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('MODEL-02');
    expect(view.error?.resumable).toBe(false);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create.mock.calls.length).toBe(1);
  });

  it('T-206/приёмка №6: бэкенд отвергает response_format → деградация и успех (решение на прогон)', async () => {
    type CreateParams = { response_format?: unknown };
    const create = vi.fn(async (params: CreateParams) => {
      if (params.response_format !== undefined) {
        throw httpError(400, 'response_format is not supported by this backend');
      }
      const content = create.mock.calls.length <= 3 ? EXTRACTION : STRUCTURE;
      return { choices: [{ message: { content } }] };
    });
    const client: AiClient = {
      models: { list: async () => ({ data: [] }) },
      chat: { completions: { create: create as never } },
    };
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.message.includes('структурированный формат'))).toBe(true);
    // json_schema → json_object → none: две деградации, решение запомнено.
    const rejected = create.mock.calls.filter((c) => c[0].response_format !== undefined).length;
    expect(rejected).toBe(2);
  });

  it('T-206: прежний фолбэк-путь (мок без поддержки usage/format) работает не хуже текущего', async () => {
    const service = makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Вход.' }));
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
  });
});
