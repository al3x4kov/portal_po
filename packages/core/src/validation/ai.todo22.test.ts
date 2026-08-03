import { describe, expect, it } from 'vitest';
import { SOURCE_TYPES } from '../domain/types.js';
import {
  AI_BACKLOG_MATCH_BATCH,
  AI_BACKLOG_MAX_BYTES,
  AI_BACKLOG_MAX_ROWS,
  AI_IMPORT_ERROR_CODES,
  AI_IMPORT_JOB_KINDS,
  AI_IMPORT_STATUSES,
  aiBacklogApplyBodySchema,
  aiBacklogMappingSchema,
  aiBacklogMatchAnswerSchema,
  aiBacklogPreviewSchema,
  aiBacklogReportSchema,
  aiBacklogReviewSchema,
  aiImportConfirmBodySchema,
  aiImportErrorFromCode,
  aiImportJobSummarySchema,
  aiImportJobViewSchema,
} from './ai.js';

/** todo_22 · T-301: shared contract of the xlsx backlog import. */
describe('todo_22 backlog contract', () => {
  it('adds the BACKLOG source type while keeping the historical ones', () => {
    expect(SOURCE_TYPES).toContain('BACKLOG');
    expect(SOURCE_TYPES).toEqual(
      expect.arrayContaining(['CLIENT', 'STAKEHOLDER', 'STANDARD', 'TEXT']),
    );
  });

  it('adds the awaiting-review status without renaming the historical ones', () => {
    expect(AI_IMPORT_STATUSES).toContain('awaiting-review');
    expect(AI_IMPORT_STATUSES).toEqual(
      expect.arrayContaining([
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'awaiting-confirmation',
        'interrupted',
      ]),
    );
  });

  it('declares the two job kinds and the backlog limits', () => {
    expect(AI_IMPORT_JOB_KINDS).toEqual(['docs', 'backlog']);
    expect(AI_BACKLOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(AI_BACKLOG_MAX_ROWS).toBe(5000);
    expect(AI_BACKLOG_MATCH_BATCH).toBe(20);
  });

  it('registers DATA-04/DATA-05 as non-resumable data errors', () => {
    for (const code of ['DATA-04', 'DATA-05'] as const) {
      const info = AI_IMPORT_ERROR_CODES[code];
      expect(info.category).toBe('data');
      expect(info.resumable).toBe(false);
      const error = aiImportErrorFromCode(code);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(10);
      expect(error.action).toBe(info.action);
      expect(info.action.length).toBeGreaterThan(10);
    }
  });

  it('validates a full preview and rejects >5 sample rows', () => {
    const preview = {
      columns: { keyColumn: 'A — Issue key', textColumn: 'B — Summary' },
      sampleRows: [{ rowId: 'r2', key: 'CRPV-1', text: 'Верстка графа коммитов' }],
      totalRows: 293,
      skippedRows: 0,
      estimate: { calls: 15, tokens: 42000 },
      fileName: 'Книга2.xlsx',
      defaultTarget: { quarter: 'Q4', year: 2026 },
    };
    expect(aiBacklogPreviewSchema.safeParse(preview).success).toBe(true);
    const tooMany = {
      ...preview,
      sampleRows: Array.from({ length: 6 }, (_, i) => ({ rowId: `r${i}`, text: 't' })),
    };
    expect(aiBacklogPreviewSchema.safeParse(tooMany).success).toBe(false);
  });

  it('validates a mapping (existing and new parents) and rejects bad parent kinds', () => {
    const base = {
      rowId: 'r2',
      key: 'CRPV-155771',
      sourceText: 'Верстка графа коммитов',
      businessName: 'Просмотр графа коммитов',
      type: 'FUNCTION',
      targetQuarter: 'Q1',
      targetYear: 2027,
      targetFromFile: false,
    };
    expect(
      aiBacklogMappingSchema.safeParse({
        ...base,
        parent: { kind: 'existing', name: 'История изменений' },
      }).success,
    ).toBe(true);
    expect(
      aiBacklogMappingSchema.safeParse({
        ...base,
        parent: { kind: 'new', name: 'Аналитика репозитория', parentName: null },
      }).success,
    ).toBe(true);
    expect(
      aiBacklogMappingSchema.safeParse({
        ...base,
        parent: { kind: 'dump', name: 'Бэклог' },
      }).success,
    ).toBe(false);
    // Target is mandatory on every mapping (implemented=false rule downstream).
    const { targetQuarter: _q, ...noTarget } = {
      ...base,
      parent: { kind: 'existing', name: 'X' },
    };
    expect(aiBacklogMappingSchema.safeParse(noTarget).success).toBe(false);
  });

  it('validates review and report payloads', () => {
    const review = {
      mappings: [],
      newNodes: [{ name: 'Аналитика', parentName: null, rowCount: 3 }],
      duplicates: 2,
    };
    expect(aiBacklogReviewSchema.safeParse(review).success).toBe(true);
    const report = {
      rowsTotal: 10,
      rowsSelected: 8,
      created: { functions: 6, nfrs: 1, links: 7, newNodes: 2 },
      duplicatesSkipped: 1,
      deselected: 2,
      usage: { promptTokens: 100, completionTokens: 20 },
    };
    expect(aiBacklogReportSchema.safeParse(report).success).toBe(true);
    expect(aiBacklogReportSchema.safeParse({ ...report, created: {} }).success).toBe(false);
  });

  it('confirm body: empty, full target, and rejects a lone quarter', () => {
    expect(aiImportConfirmBodySchema.safeParse({}).success).toBe(true);
    expect(
      aiImportConfirmBodySchema.safeParse({ targetQuarter: 'Q2', targetYear: 2027 }).success,
    ).toBe(true);
    expect(aiImportConfirmBodySchema.safeParse({ targetQuarter: 'Q2' }).success).toBe(false);
    expect(
      aiImportConfirmBodySchema.safeParse({ targetYear: 1999, targetQuarter: 'Q1' }).success,
    ).toBe(false);
  });

  it('apply body: 1..5000 row ids', () => {
    expect(aiBacklogApplyBodySchema.safeParse({ rowIds: ['r2'] }).success).toBe(true);
    expect(aiBacklogApplyBodySchema.safeParse({ rowIds: [] }).success).toBe(false);
    expect(
      aiBacklogApplyBodySchema.safeParse({
        rowIds: Array.from({ length: 5001 }, (_, i) => `r${i}`),
      }).success,
    ).toBe(false);
  });

  it('match answer schema accepts model shapes and rejects garbage', () => {
    expect(
      aiBacklogMatchAnswerSchema.safeParse({
        rowId: 'r2',
        businessName: 'Просмотр графа коммитов',
        type: 'FUNCTION',
        parentExisting: 'История изменений',
        parentNew: null,
        duplicateOf: null,
      }).success,
    ).toBe(true);
    expect(
      aiBacklogMatchAnswerSchema.safeParse({
        rowId: 'r3',
        businessName: 'Скорость отклика графа',
        type: 'NFR',
        parentNew: { name: 'Производительность', parentName: null },
      }).success,
    ).toBe(true);
    expect(
      aiBacklogMatchAnswerSchema.safeParse({ rowId: 'r4', businessName: '', type: 'FUNCTION' })
        .success,
    ).toBe(false);
  });

  it('job view/summary carry the optional kind and backlog fields (old views stay valid)', () => {
    const oldView = {
      jobId: 'j1',
      projectId: 'p1',
      status: 'running',
      stage: 'analyze',
      progress: 10,
      log: [],
    };
    expect(aiImportJobViewSchema.safeParse(oldView).success).toBe(true);
    const backlogView = {
      ...oldView,
      status: 'awaiting-review',
      kind: 'backlog',
      backlogReview: { mappings: [], newNodes: [], duplicates: 0 },
    };
    expect(aiImportJobViewSchema.safeParse(backlogView).success).toBe(true);

    const oldSummary = {
      jobId: 'j1',
      projectId: 'p1',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      resumable: false,
    };
    expect(aiImportJobSummarySchema.safeParse(oldSummary).success).toBe(true);
    expect(aiImportJobSummarySchema.safeParse({ ...oldSummary, kind: 'backlog' }).success).toBe(
      true,
    );
    expect(aiImportJobSummarySchema.safeParse({ ...oldSummary, kind: 'x' }).success).toBe(false);
  });
});
