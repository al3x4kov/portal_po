import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveModelPreset, type AiImportResult, type AiModelPreset } from '@po/core';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiClient } from '../src/services/AiHubService.js';
import type { AiImportRuntime, JsonCallOutcome } from '../src/services/aiImport/types.js';
import {
  AI_INVENTORY_LLM_MIN_CHARS,
  classifyHeuristically,
  runInventoryStage,
  type InventoryInput,
} from '../src/services/aiImport/inventoryStage.js';
import { computeEstimate, runEstimateStage } from '../src/services/aiImport/estimateStage.js';

/*
 * todo_20 · T-202: инвентаризация и контентный триаж (П1, A1, A3, F2b) +
 * T-204-заготовка: смета (П2) без подтверждения (confirm — волна 1.2).
 */

const PRESET: AiModelPreset = resolveModelPreset('gpt-test');

function harness(opts: { chat?: Array<JsonCallOutcome<unknown>> } = {}) {
  const job: AiImportJobState = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'unpack',
    progress: 5,
    log: [],
    cancelRequested: false,
  };
  const counters: AiImportResult = {
    createdFunctions: 0,
    createdNfrs: 0,
    skippedExisting: 0,
    links: 0,
    relatesLinks: 0,
  };
  const logs: Array<{ level: string; message: string }> = [];
  const queue = [...(opts.chat ?? [])];
  const chatCalls: unknown[][] = [];
  const rt: AiImportRuntime = {
    job,
    counters,
    log: (level, message) => {
      logs.push({ level, message });
      job.log.push({ ts: 't', level, message });
    },
    cancelled: () => false,
    fail: (message, hint) => {
      job.status = 'failed';
      job.error = { message, hint };
    },
    chat: async <T>(args: { messages: unknown[] }) => {
      chatCalls.push(args.messages);
      return (queue.shift() ?? { kind: 'unparsed' }) as JsonCallOutcome<T>;
    },
  };
  return { rt, job, logs, chatCalls };
}

const STUB_CLIENT = {} as AiClient;

const dirs: string[] = [];
async function writeDocs(files: Record<string, string | Buffer>): Promise<string> {
  const dir = path.join(os.tmpdir(), `po-inv-${randomBytes(8).toString('hex')}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function input(
  over: Partial<InventoryInput> & Pick<InventoryInput, 'docsDir' | 'files'>,
): InventoryInput {
  return {
    totalEntries: over.files.length,
    extensionCounts: {},
    model: 'gpt-test',
    apiKey: 'k',
    baseURL: 'http://x',
    preset: PRESET,
    makeAiClient: () => STUB_CLIENT,
    ...over,
  };
}

const RELEASE_NOTES_RU = [
  '# Что нового в версии 3.2',
  '',
  '- Добавлен быстрый фильтр по статусу.',
  '- Исправлено падение при экспорте.',
].join('\n');

const USER_GUIDE_RU = [
  '# Руководство пользователя',
  '',
  'Как выполнить поиск: откройте строку поиска и введите имя.',
].join('\n');

const API_SPEC = [
  'openapi: 3.0.0',
  'paths:',
  '  /items:',
  '    get:',
  '      summary: List items',
].join('\n');

describe('T-202 · classifyHeuristically (контент, не имена)', () => {
  it('release-notes по заголовкам (RU/EN, любой регистр)', () => {
    expect(classifyHeuristically(RELEASE_NOTES_RU)).toBe('release-notes');
    expect(classifyHeuristically("WHAT'S NEW\n- new search")).toBe('release-notes');
    expect(classifyHeuristically('Release Notes 2.0\nfixes')).toBe('release-notes');
  });

  it('руководства, безопасность, api, конфиг', () => {
    expect(classifyHeuristically(USER_GUIDE_RU)).toBe('user-guide');
    expect(classifyHeuristically('# Administration Guide\nInstall the server.')).toBe(
      'admin-guide',
    );
    expect(classifyHeuristically('# Безопасность\nПароли хранятся в виде хэша.')).toBe('security');
    expect(classifyHeuristically(API_SPEC)).toBe('api-spec');
  });

  it('обычная проза → null (кандидат на LLM-классификацию)', () => {
    expect(classifyHeuristically('Просто какой-то текст ни о чём конкретном.')).toBeNull();
  });
});

describe('T-202 · runInventoryStage', () => {
  it('классы НЕ зависят от имён: «неговорящие» имена и кириллица в путях', async () => {
    const docsDir = await writeDocs({
      'a1.md': RELEASE_NOTES_RU,
      'папка/файл2.md': USER_GUIDE_RU,
      'x/y.md': API_SPEC,
    });
    const { rt, job } = harness();
    const outcome = await runInventoryStage(rt, {
      ...input({ docsDir, files: ['a1.md', 'папка/файл2.md', 'x/y.md'] }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byPath = new Map(outcome.files.map((f) => [f.path, f.sourceClass]));
    expect(byPath.get('a1.md')).toBe('release-notes');
    expect(byPath.get('папка/файл2.md')).toBe('user-guide');
    expect(byPath.get('x/y.md')).toBe('api-spec');
    expect(job.inventory?.processed['release-notes']).toBe(1);
  });

  it('приоритетная очередь: release-notes первыми, other последними', async () => {
    const docsDir = await writeDocs({
      'zz.md': 'Просто текст.',
      'aa.md': RELEASE_NOTES_RU,
      'mm.md': USER_GUIDE_RU,
    });
    const { rt } = harness();
    const outcome = await runInventoryStage(rt, {
      ...input({ docsDir, files: ['aa.md', 'mm.md', 'zz.md'] }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files[0]!.path).toBe('aa.md');
    expect(outcome.files[outcome.files.length - 1]!.path).toBe('zz.md');
  });

  it('короткие неопознанные файлы → other БЕЗ LLM-вызова', async () => {
    const docsDir = await writeDocs({ 'note.md': 'Пара слов.' });
    const { rt, chatCalls } = harness();
    const outcome = await runInventoryStage(rt, input({ docsDir, files: ['note.md'] }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files[0]!.sourceClass).toBe('other');
    expect(chatCalls.length).toBe(0);
  });

  it('длинные неопознанные → батчевая LLM-классификация (ответ применяется)', async () => {
    const longProse = `Текст про систему. ${'Слово '.repeat(200)}`;
    expect(longProse.length).toBeGreaterThan(AI_INVENTORY_LLM_MIN_CHARS);
    const docsDir = await writeDocs({ 'p1.md': longProse, 'p2.md': longProse });
    const { rt, chatCalls } = harness({
      chat: [
        {
          kind: 'ok',
          value: [
            { path: 'p1.md', class: 'security' },
            { path: 'p2.md', class: 'config' },
          ],
        },
      ],
    });
    const outcome = await runInventoryStage(rt, input({ docsDir, files: ['p1.md', 'p2.md'] }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(chatCalls.length).toBe(1);
    const byPath = new Map(outcome.files.map((f) => [f.path, f.sourceClass]));
    expect(byPath.get('p1.md')).toBe('security');
    expect(byPath.get('p2.md')).toBe('config');
  });

  it('LLM недоступна → warn, все неопознанные → other, прогон НЕ падает', async () => {
    const longProse = `Текст про систему. ${'Слово '.repeat(200)}`;
    const docsDir = await writeDocs({ 'p1.md': longProse });
    const { rt, job, logs } = harness({
      chat: [{ kind: 'upstream', error: new Error('hub down'), errorClass: 'unknown' }],
    });
    const outcome = await runInventoryStage(rt, input({ docsDir, files: ['p1.md'] }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files[0]!.sourceClass).toBe('other');
    expect(job.status).toBe('running');
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('классификаци'))).toBe(true);
  });

  it('бинарное содержимое → excluded с причиной (никогда молча)', async () => {
    const docsDir = await writeDocs({
      'ok.md': RELEASE_NOTES_RU,
      'bin.md': Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00, 0x03]),
    });
    const { rt, job } = harness();
    const outcome = await runInventoryStage(rt, input({ docsDir, files: ['ok.md', 'bin.md'] }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files.map((f) => f.path)).toEqual(['ok.md']);
    const excluded = job.inventory?.excluded ?? [];
    expect(excluded.some((e) => e.path === 'bin.md' && e.reason.length > 0)).toBe(true);
  });

  it('не-текстовые файлы архива попадают в excluded из extensionCounts', async () => {
    const docsDir = await writeDocs({ 'ok.md': RELEASE_NOTES_RU });
    const { rt, job } = harness();
    const outcome = await runInventoryStage(rt, {
      ...input({ docsDir, files: ['ok.md'] }),
      totalEntries: 4,
      extensionCounts: { '.md': 1, '.png': 2, '': 1 },
    });
    expect(outcome.ok).toBe(true);
    const excluded = job.inventory?.excluded ?? [];
    expect(excluded.some((e) => e.path === '*.png' && e.count === 2)).toBe(true);
    expect(job.inventory?.totalFiles).toBe(4);
  });
});

describe('T-204-заготовка · смета (без подтверждения в волне 1.1)', () => {
  it('computeEstimate: чанки/вызовы/токены из описи и chunkChars', () => {
    const est = computeEstimate({
      files: [
        { path: 'a.md', sourceClass: 'other', size: 25_000 },
        { path: 'b.md', sourceClass: 'other', size: 100 },
      ],
      chunkChars: 10_000,
      thresholdTokens: PRESET.estimateThresholdTokens,
    });
    expect(est.files).toBe(2);
    expect(est.chunks).toBe(4); // ceil(25000/10000)=3 + 1
    expect(est.calls).toBeGreaterThanOrEqual(est.chunks);
    expect(est.tokens).toBeGreaterThan(0);
    expect(est.thresholdTokens).toBe(2_000_000);
    expect(est.overThreshold).toBe(false);
  });

  it('порог 0 = подтверждать всегда; null = никогда', () => {
    const files = [{ path: 'a.md', sourceClass: 'other' as const, size: 10 }];
    expect(computeEstimate({ files, chunkChars: 1000, thresholdTokens: 0 }).overThreshold).toBe(
      true,
    );
    expect(computeEstimate({ files, chunkChars: 1000, thresholdTokens: null }).overThreshold).toBe(
      false,
    );
  });

  it('runEstimateStage пишет смету в job view и лог', async () => {
    const { rt, job, logs } = harness();
    const outcome = await runEstimateStage(rt, {
      files: [{ path: 'a.md', sourceClass: 'release-notes', size: 5000 }],
      chunkChars: 1000,
      thresholdTokens: null,
    });
    expect(outcome.ok).toBe(true);
    expect(job.estimate?.files).toBe(1);
    expect(job.estimate?.chunks).toBe(5);
    expect(logs.some((l) => l.message.includes('Смета'))).toBe(true);
    expect(job.progress).toBe(10);
  });
});
