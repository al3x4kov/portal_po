import { describe, expect, it } from 'vitest';
import {
  aiImportErrorFromCode,
  type AiBacklogMapping,
  type AiImportResult,
  type Requirement,
} from '@po/core';
import {
  buildBacklogMatchMessages,
  buildBacklogTreeMap,
  parseMatchResponse,
  runBacklogMatchStage,
} from '../src/services/aiImport/backlogMatchStage.js';
import type { BacklogRow } from '../src/services/aiImport/backlogXlsx.js';
import type { AiJobCheckpoint } from '../src/services/aiImport/checkpoint.js';
import type { AiImportRuntime, ChatArgs, JsonCallOutcome } from '../src/services/aiImport/types.js';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiClient } from '../src/services/AiHubService.js';
import type { AiCallErrorClass } from '../src/services/aiImport/aiCall.js';

/** todo_22 · T-303: match stage over a scripted runtime (no real service loop). */

type Scripted = string | { upstream: AiCallErrorClass };

interface StageHarness {
  rt: AiImportRuntime;
  job: AiImportJobState;
  state: AiJobCheckpoint;
  requests: string[];
  checkpoints: () => number;
}

function makeHarness(answers: Scripted[]): StageHarness {
  const job: AiImportJobState = {
    jobId: 'j1',
    projectId: 'p1',
    status: 'running',
    stage: 'analyze',
    progress: 0,
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
  const state: AiJobCheckpoint = {
    version: 1,
    kind: 'backlog',
    jobId: 'j1',
    projectId: 'p1',
    model: 'm',
    inferLinks: false,
    startedAt: '2026-08-03T00:00:00.000Z',
    status: 'running',
    stage: 'analyze',
    progress: 0,
    confirmed: true,
    log: [],
    counters,
    backlog: { fileName: 'backlog.xlsx', rows: [] },
  };
  const requests: string[] = [];
  let checkpointCount = 0;
  const rt: AiImportRuntime = {
    job,
    counters,
    log: (level, message) => job.log.push({ ts: 't', level, message }),
    cancelled: () => false,
    fail: (message, hint) => {
      job.status = 'failed';
      job.error = { message, hint };
    },
    failCode: (code, overrides) => {
      job.status = 'failed';
      job.error = aiImportErrorFromCode(code, overrides);
    },
    chat: async <T>(args: ChatArgs<T>): Promise<JsonCallOutcome<T>> => {
      requests.push(args.messages.map((m) => m.content).join('\n'));
      const answer = answers.shift();
      if (answer === undefined) throw new Error('no scripted answer left');
      if (typeof answer !== 'string') {
        return { kind: 'upstream', error: new Error('boom'), errorClass: answer.upstream };
      }
      const value = args.parse(answer) ?? args.parseFinal?.(answer) ?? null;
      return value === null ? { kind: 'unparsed' } : { kind: 'ok', value };
    },
    checkpoint: (mutate) => {
      checkpointCount += 1;
      mutate?.(state);
    },
  };
  return { rt, job, state, requests, checkpoints: () => checkpointCount };
}

function req(
  type: 'FUNCTION' | 'NFR',
  name: string,
  slug: string,
  parentSlug?: string,
): Requirement {
  return {
    slug,
    type,
    name,
    criticality: 'MEDIUM',
    implemented: true,
    links: parentSlug ? [{ type: 'CHILD_OF', targetSlug: parentSlug }] : [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const EXISTING: Requirement[] = [
  req('FUNCTION', 'История изменений', 'istoriya'),
  req('FUNCTION', 'Просмотр диффа', 'diff', 'istoriya'),
  req('NFR', 'Производительность интерфейса', 'perf'),
];

function rows(n: number, withTargetEvery = 0): BacklogRow[] {
  return Array.from({ length: n }, (_, i) => ({
    rowId: `r${i + 2}`,
    key: `AB-${i + 1}`,
    text: `Формулировка задачи номер ${i + 1}`,
    ...(withTargetEvery > 0 && (i + 1) % withTargetEvery === 0
      ? { target: { quarter: 'Q3' as const, year: 2027 } }
      : {}),
  }));
}

/** Valid answer array mapping every row of the batch to an existing node. */
function answerFor(batch: BacklogRow[], overrides: Record<string, object> = {}): string {
  return JSON.stringify(
    batch.map((row) => ({
      rowId: row.rowId,
      businessName: `Бизнес ${row.rowId}`,
      type: 'FUNCTION',
      parentExisting: 'История изменений',
      parentNew: null,
      duplicateOf: null,
      ...(overrides[row.rowId] ?? {}),
    })),
  );
}

const TARGET = { quarter: 'Q1' as const, year: 2027 };

function input(harness: StageHarness, backlogRows: BacklogRow[], extra: object = {}) {
  return {
    rows: backlogRows,
    target: TARGET,
    existing: EXISTING,
    client: {} as AiClient, // the scripted rt.chat never touches the client
    model: 'm',
    apiKey: 'sk-x',
    preset: {
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 12_000,
      reasoning: 'none' as const,
      parallelism: 2,
      perCallTimeoutSec: 120,
      runBudgetTokens: null,
      estimateThresholdTokens: null,
    },
    batchSize: 20,
    ...extra,
  };
}

describe('T-303 · backlog match stage', () => {
  it('maps 45 rows in 3 batches with a checkpoint after every batch', async () => {
    const all = rows(45, 5); // every 5th row carries a file target
    const batches = [all.slice(0, 20), all.slice(20, 40), all.slice(40)];
    const harness = makeHarness(batches.map((b) => answerFor(b)));
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(harness.requests).toHaveLength(3);
    expect(harness.checkpoints()).toBeGreaterThanOrEqual(3);
    expect(harness.state.backlog?.match?.mappings).toHaveLength(45);
    const review = outcome.review;
    expect(review.mappings).toHaveLength(45);
    expect(review.mappings.map((m) => m.rowId)).toEqual(all.map((r) => r.rowId));
    // Shared target vs file target (targetFromFile flag).
    const fromFile = review.mappings.filter((m) => m.targetFromFile);
    expect(fromFile).toHaveLength(9);
    expect(fromFile[0]).toMatchObject({ targetQuarter: 'Q3', targetYear: 2027 });
    const shared = review.mappings.find((m) => !m.targetFromFile)!;
    expect(shared).toMatchObject({ targetQuarter: 'Q1', targetYear: 2027 });
    expect(review.newNodes).toHaveLength(0);
    expect(review.duplicates).toBe(0);
  });

  it('hallucinated parentExisting → new root node with a warn; fake duplicateOf → cleared', async () => {
    const all = rows(2);
    const harness = makeHarness([
      answerFor(all, {
        r2: { parentExisting: 'Несуществующий узел' },
        r3: { duplicateOf: 'Выдуманное требование' },
      }),
    ]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [m2, m3] = outcome.review.mappings;
    expect(m2!.parent).toEqual({ kind: 'new', name: 'Несуществующий узел', parentName: null });
    expect(m3!.duplicateOf).toBeUndefined();
    const warns = harness.job.log.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns.some((w) => w.includes('не найден в дереве'))).toBe(true);
    expect(warns.some((w) => w.includes('пометка снята'))).toBe(true);
    expect(outcome.review.newNodes).toEqual([
      { name: 'Несуществующий узел', parentName: null, rowCount: 1 },
    ]);
  });

  it('deduplicates new nodes across batches by normalized name', async () => {
    const all = rows(4);
    const batch1 = all.slice(0, 2);
    const batch2 = all.slice(2);
    const node = (name: string) => ({
      parentExisting: null,
      parentNew: { name, parentName: null },
    });
    const harness = makeHarness([
      answerFor(batch1, { r2: node('Аналитика Репозитория'), r3: node('Аналитика Репозитория') }),
      answerFor(batch2, { r4: node('аналитика репозитория!'), r5: node('Экспорт данных') }),
    ]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all, { batchSize: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.review.newNodes).toEqual([
      { name: 'Аналитика Репозитория', parentName: null, rowCount: 3 },
      { name: 'Экспорт данных', parentName: null, rowCount: 1 },
    ]);
    // The canonical (first-seen) name is used on every mapping.
    expect(
      outcome.review.mappings.filter((m) => m.parent.name === 'Аналитика Репозитория'),
    ).toHaveLength(3);
  });

  it('splits an unanswerable batch in half; a lone failing row → MODEL-01', async () => {
    const all = rows(4);
    const harness = makeHarness([
      'мусор без json', // whole batch of 4 → split 2+2
      answerFor(all.slice(0, 2)),
      answerFor(all.slice(2)),
    ]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all, { batchSize: 4 }));
    expect(outcome.ok).toBe(true);
    expect(harness.requests).toHaveLength(3);

    const single = rows(1);
    const failing = makeHarness(['мусор', 'опять мусор']);
    const failed = await runBacklogMatchStage(failing.rt, input(failing, single, { batchSize: 4 }));
    expect(failed.ok).toBe(false);
    expect(failing.job.status).toBe('failed');
    expect(failing.job.error?.code).toBe('MODEL-01');
    expect(failing.job.error?.resumable).toBe(true);
  });

  it('resume: already-paid mappings are never re-sent to the model', async () => {
    const all = rows(45);
    const paid: AiBacklogMapping[] = all.slice(0, 40).map((row) => ({
      rowId: row.rowId,
      key: row.key!,
      sourceText: row.text,
      businessName: `Бизнес ${row.rowId}`,
      type: 'FUNCTION',
      parent: { kind: 'existing', name: 'История изменений' },
      targetQuarter: 'Q1',
      targetYear: 2027,
      targetFromFile: false,
    }));
    const harness = makeHarness([answerFor(all.slice(40))]);
    const outcome = await runBacklogMatchStage(
      harness.rt,
      input(harness, all, { resume: { mappings: paid } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).not.toContain('r2\t'); // paid row not re-sent
    expect(harness.requests[0]).toContain('r42\t');
    expect(outcome.review.mappings).toHaveLength(45);
  });

  it('per-row лог «исходное → преобразованное»: строка, бизнес-имя, узел, срок', async () => {
    const all = rows(2, 2); // у AB-2 срок из файла
    const harness = makeHarness([answerFor(all)]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all));
    expect(outcome.ok).toBe(true);
    const infos = harness.job.log.filter((l) => l.level === 'info').map((l) => l.message);
    expect(infos).toContain(
      'Строка AB-1: «Формулировка задачи номер 1» → ФТ «Бизнес r2» · ' +
        'узел: «История изменений» (существующий) · срок: Q1 2027',
    );
    // Срок из файла помечен явно; итоговая строка прогресса присутствует.
    expect(
      infos.some((m) => m.startsWith('Строка AB-2:') && m.includes('Q3 2027 (из файла)')),
    ).toBe(true);
    expect(infos).toContain('Размечено строк: 2 из 2.');
  });

  it('повторный ответ модели по той же строке: первый побеждает, warn со счётчиком', async () => {
    const all = rows(1);
    const twice = JSON.stringify([
      {
        rowId: 'r2',
        businessName: 'Первый вариант',
        type: 'FUNCTION',
        parentExisting: 'История изменений',
        parentNew: null,
        duplicateOf: null,
      },
      {
        rowId: 'r2',
        businessName: 'Второй вариант',
        type: 'FUNCTION',
        parentExisting: 'Просмотр диффа',
        parentNew: null,
        duplicateOf: null,
      },
    ]);
    const harness = makeHarness([twice]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.review.mappings).toHaveLength(1);
    expect(outcome.review.mappings[0]!.businessName).toBe('Первый вариант');
    const warns = harness.job.log.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns.some((w) => w.includes('повторных ответов по уже размеченным строкам: 1'))).toBe(
      true,
    );
  });

  it('переотправка без ответа: warn называет строки, доп. батч помечен явно', async () => {
    const all = rows(3);
    // Батч 1 (r2,r3): ответ только по r2; батч 2 (r4): полный; доп. батч: r3.
    const harness = makeHarness([answerFor([all[0]!]), answerFor([all[2]!]), answerFor([all[1]!])]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all, { batchSize: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.review.mappings).toHaveLength(3);
    const messages = harness.job.log.map((l) => l.message);
    expect(
      messages.some(
        (m) => m.includes('модель не ответила по строкам: AB-2') && m.includes('повторно'),
      ),
    ).toBe(true);
    // Честная нумерация: третий отправленный батч — явно «доп.», а не «батч 2/2».
    expect(
      messages.some((m) => m.includes('доп. батч 3 — повторная отправка') && m.includes('AB-2')),
    ).toBe(true);
  });

  it('fatal upstream errors map to registry codes (auth → CFG-02)', async () => {
    const all = rows(2);
    const harness = makeHarness([{ upstream: 'auth' }]);
    const outcome = await runBacklogMatchStage(harness.rt, input(harness, all));
    expect(outcome.ok).toBe(false);
    expect(harness.job.error?.code).toBe('CFG-02');
  });

  it('tree map carries names with parents; prompt forbids dump groups with examples', () => {
    const map = buildBacklogTreeMap(EXISTING);
    expect(map).toContain('FUNCTION\tПросмотр диффа\tродитель: История изменений');
    expect(map).toContain('NFR\tПроизводительность интерфейса\tродитель: —');
    const messages = buildBacklogMatchMessages(rows(1), map);
    const system = messages[0]!.content;
    expect(system).toContain('ЗАПРЕЩЕНО');
    expect(system).toContain('«Бэклог»'); // bad example present verbatim
    expect(system).toContain('«Просмотр истории изменений»'); // good example
    expect(messages[1]!.content).toContain('r2\tAB-1\t');
  });

  it('parseMatchResponse: strict drops the whole answer, lenient keeps the valid part', () => {
    const ids = new Set(['r2', 'r3']);
    const mixed = JSON.stringify([
      { rowId: 'r2', businessName: 'А', type: 'FUNCTION', parentExisting: 'X' },
      { rowId: 'чужой', businessName: 'Б', type: 'FUNCTION' },
    ]);
    expect(parseMatchResponse(mixed, ids)).toBeNull();
    expect(parseMatchResponse(mixed, ids, 'lenient')).toHaveLength(1);
    expect(parseMatchResponse('не json', ids, 'lenient')).toBeNull();
  });
});
