import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiImportJobSummary, AiImportJobView, Requirement } from '@po/core';
import { AiBacklogImportModal, batchFromLog } from './AiBacklogImportModal';
import { SOURCE_TYPE_LABEL, SOURCE_TYPE_ICON, SOURCE_TYPES_ORDER } from '../lib/sourceTypes';
import { renderWithProviders } from '../test/utils';

/**
 * todo_22 (T-305/T-306): backlog import — upload/preview/target gate, batched
 * progress, the mandatory review gate (PO №1), report, history with the kind
 * badge and the BACKLOG source-type dictionaries.
 */

const getConfig = vi.fn();
const listModels = vi.fn();
const startBacklog = vi.fn();
const getJob = vi.fn();
const cancelJob = vi.fn();
const confirmJob = vi.fn();
const applyJob = vi.fn();
const resumeJob = vi.fn();
const listJobs = vi.fn();
const listRequirements = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {},
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
  },
  linksApi: {},
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    listModels: (...a: unknown[]) => listModels(...a),
  },
  aiImportApi: {
    startBacklog: (...a: unknown[]) => startBacklog(...a),
    getJob: (...a: unknown[]) => getJob(...a),
    cancel: (...a: unknown[]) => cancelJob(...a),
    confirm: (...a: unknown[]) => confirmJob(...a),
    apply: (...a: unknown[]) => applyJob(...a),
    resume: (...a: unknown[]) => resumeJob(...a),
    listJobs: (...a: unknown[]) => listJobs(...a),
    logUrl: (jobId: string) => `/api/ai-import/${jobId}/log`,
  },
}));

// The modal checks `err instanceof ApiError` — use the real class in mocks.
import { ApiError } from '../api/client';

const CONFIGURED = {
  baseURL: 'https://api.ai.sbt/openai/v1',
  hasApiKey: true,
  model: 'GigaChat-2-Pro',
};
const MODELS = { models: ['GigaChat-2-Pro', 'Qwen3.5-397B'] };

const BASE_JOB: AiImportJobView = {
  jobId: 'job-b1',
  projectId: 'proj-1',
  status: 'running',
  stage: 'unpack',
  progress: 5,
  log: [],
  kind: 'backlog',
};

const PREVIEW_JOB: AiImportJobView = {
  ...BASE_JOB,
  status: 'awaiting-confirmation',
  backlogPreview: {
    columns: { keyColumn: 'A — «Issue key»', textColumn: 'B — «Summary»' },
    sampleRows: [
      { rowId: 'r1', key: 'CRPV-155771', text: 'Отсутствует поиск по кодовой базе' },
      { rowId: 'r2', key: 'CRPV-155770', text: 'Дополнительный триггер на перепривязку задач' },
      { rowId: 'r3', key: 'CRPV-154133', text: '[Radish] Graceful Degradation' },
      { rowId: 'r4', key: 'CRPV-153820', text: '[PR-Создание] Панель статистики файлов' },
      { rowId: 'r5', key: 'CRPV-153815', text: '[Проект. Список PR] Доработка фильтров' },
    ],
    totalRows: 214,
    skippedRows: 3,
    estimate: { calls: 14, tokens: 90_000 },
    fileName: 'Книга2.xlsx',
    defaultTarget: { quarter: 'Q4', year: 2026 },
  },
};

const RUNNING_MATCH: AiImportJobView = {
  ...BASE_JOB,
  status: 'running',
  stage: 'analyze',
  progress: 43,
  usage: { promptTokens: 40_000, completionTokens: 8_000 },
  log: [
    { ts: '2026-08-03T16:40:12.000Z', level: 'info', message: 'Батч 5: 20 строк размечено' },
    {
      ts: '2026-08-03T16:41:02.000Z',
      level: 'info',
      message: 'Разметка бэклога (батч 6/14): строк 20 — запрос к модели…',
    },
  ],
};

const REVIEW_JOB: AiImportJobView = {
  ...BASE_JOB,
  status: 'awaiting-review',
  stage: 'analyze',
  progress: 80,
  backlogPreview: PREVIEW_JOB.backlogPreview,
  backlogReview: {
    mappings: [
      {
        rowId: 'r1',
        key: 'CRPV-153811',
        sourceText: 'Верстка графа коммитов',
        businessName: 'Визуализация графа коммитов',
        type: 'FUNCTION',
        parent: { kind: 'existing', name: 'Работа с репозиторием' },
        targetQuarter: 'Q4',
        targetYear: 2026,
        targetFromFile: false,
      },
      {
        rowId: 'r2',
        key: 'CRPV-155770',
        sourceText: 'Дополнительный триггер на перепривязку задач Сбертрек',
        businessName: 'Автоперепривязка задач Сбертрек',
        type: 'FUNCTION',
        parent: { kind: 'new', name: 'Интеграция с трекерами задач', parentName: null },
        targetQuarter: 'Q4',
        targetYear: 2026,
        targetFromFile: false,
      },
      {
        rowId: 'r3',
        key: 'CRPV-155771',
        sourceText: 'Отсутствует поиск по кодовой базе',
        businessName: 'Поиск по кодовой базе',
        type: 'FUNCTION',
        parent: { kind: 'existing', name: 'Поиск' },
        duplicateOf: 'Поиск по коду',
        targetQuarter: 'Q4',
        targetYear: 2026,
        targetFromFile: false,
      },
      {
        rowId: 'r4',
        key: 'CRPV-151850',
        sourceText: 'Оценить поддержку развертывания на Astra 1.8',
        businessName: 'Поддержка развёртывания на Astra Linux 1.8',
        type: 'NFR',
        parent: { kind: 'existing', name: 'Совместимость платформ' },
        targetQuarter: 'Q1',
        targetYear: 2027,
        targetFromFile: true,
      },
    ],
    newNodes: [{ name: 'Интеграция с трекерами задач', parentName: null, rowCount: 1 }],
    duplicates: 1,
  },
};

const SUCCEEDED_JOB: AiImportJobView = {
  ...REVIEW_JOB,
  status: 'succeeded',
  stage: 'done',
  progress: 100,
  usage: { promptTokens: 80_000, completionTokens: 12_000 },
  backlogReport: {
    rowsTotal: 4,
    rowsSelected: 3,
    created: { functions: 2, nfrs: 1, links: 3, newNodes: 1 },
    duplicatesSkipped: 1,
    deselected: 0,
    usage: { promptTokens: 80_000, completionTokens: 12_000 },
  },
};

const HISTORY: { jobs: AiImportJobSummary[] } = {
  jobs: [
    {
      jobId: 'job-h1',
      projectId: 'proj-1',
      status: 'awaiting-review',
      startedAt: '2026-08-01T18:42:00.000Z',
      resumable: false,
      kind: 'backlog',
    },
    {
      jobId: 'job-h2',
      projectId: 'proj-1',
      status: 'succeeded',
      startedAt: '2026-07-30T10:00:00.000Z',
      finishedAt: '2026-07-30T12:00:00.000Z',
      result: {
        createdFunctions: 642,
        createdNfrs: 87,
        skippedExisting: 3,
        links: 700,
        relatesLinks: 1,
      },
      resumable: false,
    },
  ],
};

/** task25: the real project tree behind the parent-picker of the review step. */
function treeNode(
  slug: string,
  type: Requirement['type'],
  name: string,
  parentSlug?: string,
): Requirement {
  return {
    slug,
    type,
    name,
    criticality: 'MEDIUM',
    implemented: true,
    links: parentSlug ? [{ type: 'CHILD_OF', targetSlug: parentSlug }] : [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const TREE = {
  requirements: [
    treeNode('repo-work', 'FUNCTION', 'Работа с репозиторием'),
    treeNode('search', 'FUNCTION', 'Поиск', 'repo-work'),
    treeNode('platform-compat', 'NFR', 'Совместимость платформ'),
  ],
  broken: [],
  incomplete: [],
};

const xlsx = new File(['dummy-xlsx-bytes'], 'Книга2.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

function renderModal(onClose = vi.fn()) {
  const utils = renderWithProviders(<AiBacklogImportModal projectId="proj-1" onClose={onClose} />);
  return { ...utils, onClose };
}

async function startJob(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.upload(screen.getByTestId('ai-backlog-file'), xlsx);
  await waitFor(() => expect(screen.getByTestId('ai-backlog-start')).not.toBeDisabled());
  await user.click(screen.getByTestId('ai-backlog-start'));
}

beforeEach(() => {
  getConfig.mockReset().mockResolvedValue(CONFIGURED);
  listModels.mockReset().mockResolvedValue(MODELS);
  startBacklog.mockReset().mockResolvedValue({ jobId: 'job-b1' });
  getJob.mockReset().mockResolvedValue(PREVIEW_JOB);
  cancelJob.mockReset().mockResolvedValue({ ...PREVIEW_JOB, status: 'cancelled' });
  confirmJob.mockReset().mockResolvedValue(RUNNING_MATCH);
  applyJob.mockReset().mockResolvedValue({ ...REVIEW_JOB, status: 'running', stage: 'populate' });
  resumeJob.mockReset().mockResolvedValue({ jobId: 'job-b1' });
  listJobs.mockReset().mockResolvedValue({ jobs: [] });
  listRequirements.mockReset().mockResolvedValue(TREE);
});

describe('AiBacklogImportModal — setup (T-305)', () => {
  it('rejects a non-xlsx file with a readable message', async () => {
    // `accept=".xlsx"` filters the picker; the drop path has no such filter —
    // bypass the accept check to exercise the client-side validation.
    const user = userEvent.setup({ applyAccept: false });
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');

    const csv = new File(['a;b'], 'backlog.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('ai-backlog-file'), csv);
    expect(await screen.findByTestId('ai-backlog-start-error')).toHaveTextContent(
      'Нужен файл .xlsx',
    );
    expect(screen.getByTestId('ai-backlog-start')).toBeDisabled();
  });

  it('uploads the xlsx and starts the job (model from the project config)', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    expect(startBacklog).toHaveBeenCalledWith('proj-1', xlsx, undefined);
    // The job pauses on the preview gate.
    expect(await screen.findByTestId('ai-backlog-preview-step')).toBeInTheDocument();
  });

  it('409 on start explains the abandoned review gate (cancel/apply to unblock)', async () => {
    startBacklog.mockRejectedValue(
      new ApiError(409, { code: 'CONFLICT', message: 'AI import job is already running.' }),
    );
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    const err = await screen.findByTestId('ai-backlog-start-error');
    expect(err).toHaveTextContent('ждёт выверки');
    expect(err).toHaveTextContent('«Записать в проект»');
  });
});

describe('preview gate (П2, mockup 01)', () => {
  it('shows recognized columns, 5 sample rows, totals and the estimate', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-preview-step');
    expect(screen.getByTestId('ai-backlog-col-key')).toHaveTextContent('Ключ: A — «Issue key»');
    expect(screen.getByTestId('ai-backlog-col-text')).toHaveTextContent(
      'Формулировка: B — «Summary»',
    );
    expect(screen.queryByTestId('ai-backlog-col-target')).not.toBeInTheDocument();

    expect(screen.getAllByTestId('ai-backlog-sample-row')).toHaveLength(5);
    expect(screen.getByTestId('ai-backlog-rows-summary')).toHaveTextContent(
      '214 строк к обработке, 3 пустых пропущено',
    );

    const estimate = screen.getByTestId('ai-backlog-estimate');
    expect(estimate).toHaveTextContent('≈ 14');
    expect(estimate).toHaveTextContent('≈ 90 тыс.');
  });

  it('target field defaults to the server defaultTarget with the «no terms in file» hint', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-preview-step');
    expect(screen.getByTestId('ai-backlog-target-quarter')).toHaveValue('Q4');
    expect(screen.getByTestId('ai-backlog-target-year')).toHaveValue(2026);
    expect(screen.getByTestId('ai-backlog-target-hint')).toHaveTextContent(
      'в файле сроки не найдены',
    );
  });

  it('marks the target field when the file has its own target column', async () => {
    getJob.mockResolvedValue({
      ...PREVIEW_JOB,
      backlogPreview: {
        ...PREVIEW_JOB.backlogPreview!,
        columns: { ...PREVIEW_JOB.backlogPreview!.columns, targetColumn: 'C — «Due date»' },
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-preview-step');
    expect(screen.getByTestId('ai-backlog-col-target')).toHaveTextContent('Срок: C — «Due date»');
    expect(screen.getByTestId('ai-backlog-target-hint')).toHaveTextContent('сроки найдены в файле');
  });

  it('«Начать анализ» confirms with the chosen target (both fields together)', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-preview-step');
    await user.selectOptions(screen.getByTestId('ai-backlog-target-quarter'), 'Q2');
    await user.clear(screen.getByTestId('ai-backlog-target-year'));
    await user.type(screen.getByTestId('ai-backlog-target-year'), '2027');
    await user.click(screen.getByTestId('ai-backlog-confirm-start'));

    expect(confirmJob).toHaveBeenCalledWith('job-b1', { targetQuarter: 'Q2', targetYear: 2027 });
    // The fresh running view lands in the cache → progress screen.
    expect(await screen.findByTestId('ai-backlog-progress')).toBeInTheDocument();
  });

  it('«Отмена» on the gate cancels the job for free and closes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-preview-step');
    await user.click(screen.getByTestId('ai-backlog-preview-cancel'));
    expect(cancelJob).toHaveBeenCalledWith('job-b1');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('progress (П5.1, mockup 02) — terminology «батч»/«строка»', () => {
  it('shows «батч X из Y» from the log, counters and the stop guard', async () => {
    getJob.mockResolvedValue(RUNNING_MATCH);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-progress');
    expect(screen.getByTestId('ai-backlog-stage')).toHaveTextContent('Соотнесение с деревом');
    expect(screen.getByTestId('ai-backlog-batch')).toHaveTextContent('батч 6 из 14');
    expect(screen.getByTestId('ai-backlog-progress-pct')).toHaveTextContent('43%');

    const counters = screen.getByTestId('ai-backlog-counters');
    expect(within(counters).getByTestId('ai-backlog-counter-tokens')).toHaveTextContent('48 тыс.');

    // No docs terminology leaks into the backlog modal.
    expect(screen.getByTestId('ai-backlog-import')).not.toHaveTextContent(/фрагмент/i);

    await user.click(screen.getByTestId('ai-backlog-stop'));
    await user.click(screen.getByTestId('ai-backlog-stop-confirm-confirm'));
    expect(cancelJob).toHaveBeenCalledWith('job-b1');
  });

  it('batchFromLog picks the LAST batch marker', () => {
    expect(
      batchFromLog([
        { message: 'Разметка бэклога (батч 1/14): строк 20' },
        { message: 'Разметка бэклога (батч 2/14): строк 20' },
      ]),
    ).toEqual({ current: 2, total: 14 });
    expect(batchFromLog([{ message: 'ничего' }])).toBeNull();
  });
});

describe('review gate (PO №1, mockup 04, T-306)', () => {
  async function openReview(user: ReturnType<typeof userEvent.setup>) {
    getJob.mockResolvedValue(REVIEW_JOB);
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);
    await screen.findByTestId('ai-backlog-review-step');
  }

  it('lists the new nodes and selects everything except duplicates by default', async () => {
    const user = userEvent.setup();
    await openReview(user);

    const nodes = screen.getByTestId('ai-backlog-new-nodes');
    expect(nodes).toHaveTextContent('Будут созданы новые узлы дерева (1)');
    expect(nodes).toHaveTextContent('Интеграция с трекерами задач');
    expect(nodes).toHaveTextContent('корневой узел');

    expect(screen.getByTestId('ai-backlog-selected-count')).toHaveTextContent('выбрано 3 из 4');
    const rows = screen.getAllByTestId('ai-backlog-review-row');
    expect(rows).toHaveLength(4);

    // The duplicate row: disabled checkbox, badge, no target cell content.
    const dupRow = rows.find((r) => r.getAttribute('data-rowid') === 'r3')!;
    expect(within(dupRow).getByTestId('ai-backlog-row-checkbox')).toBeDisabled();
    expect(within(dupRow).getByTestId('ai-backlog-badge-duplicate')).toHaveTextContent('дубль');
    expect(dupRow).toHaveTextContent('не будет записана (есть «Поиск по коду»)');

    // НФТ badge + the file-target marker on the NFR row. task25: the target
    // cell is now an editable pair prefilled with the row values.
    const nfrRow = rows.find((r) => r.getAttribute('data-rowid') === 'r4')!;
    expect(within(nfrRow).getByTestId('ai-backlog-badge-nfr')).toHaveTextContent('НФТ');
    expect(within(nfrRow).getByTestId('ai-backlog-target-quarter-cell')).toHaveValue('Q1');
    expect(within(nfrRow).getByTestId('ai-backlog-target-year-cell')).toHaveValue(2027);
    expect(within(nfrRow).getByTestId('ai-backlog-target-from-file')).toBeInTheDocument();

    // New-node badge on the row going under the proposed node.
    const newNodeRow = rows.find((r) => r.getAttribute('data-rowid') === 'r2')!;
    expect(within(newNodeRow).getByTestId('ai-backlog-badge-new-node')).toHaveTextContent(
      'новый узел',
    );
  });

  it('deselect updates the counter and the apply payload; empty selection disables the write', async () => {
    const user = userEvent.setup();
    await openReview(user);

    const rows = screen.getAllByTestId('ai-backlog-review-row');
    const firstRow = rows.find((r) => r.getAttribute('data-rowid') === 'r1')!;
    await user.click(within(firstRow).getByTestId('ai-backlog-row-checkbox'));
    expect(screen.getByTestId('ai-backlog-selected-count')).toHaveTextContent('выбрано 2 из 4');
    expect(screen.getByTestId('ai-backlog-apply')).toHaveTextContent('Записать в проект (2)');

    await user.click(screen.getByTestId('ai-backlog-apply'));
    // task25: the body form; no edits → no `overrides` key at all.
    expect(applyJob).toHaveBeenCalledWith('job-b1', { rowIds: ['r2', 'r4'] });
  });

  it('select-all toggles every non-duplicate row; zero selection disables apply', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(screen.getByTestId('ai-backlog-select-all'));
    expect(screen.getByTestId('ai-backlog-selected-count')).toHaveTextContent('выбрано 0 из 4');
    expect(screen.getByTestId('ai-backlog-apply')).toBeDisabled();

    await user.click(screen.getByTestId('ai-backlog-select-all'));
    expect(screen.getByTestId('ai-backlog-selected-count')).toHaveTextContent('выбрано 3 из 4');
    expect(screen.getByTestId('ai-backlog-apply')).not.toBeDisabled();
  });

  it('«Отмена» on review asks for confirmation before discarding the paid markup', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(screen.getByTestId('ai-backlog-review-cancel'));
    const dialog = screen.getByTestId('ai-backlog-cancel-review-confirm');
    expect(dialog).toHaveTextContent('Разметка будет отброшена');
    await user.click(screen.getByTestId('ai-backlog-cancel-review-confirm-confirm'));
    expect(cancelJob).toHaveBeenCalledWith('job-b1');
  });

  it('apply error (e.g. 409) is shown inside the review step', async () => {
    applyJob.mockRejectedValue(
      new ApiError(409, { code: 'CONFLICT', message: 'Job is not awaiting review.' }),
    );
    const user = userEvent.setup();
    await openReview(user);

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(await screen.findByTestId('ai-backlog-apply-error')).toHaveTextContent(
      'Job is not awaiting review.',
    );
  });

  it('an awaiting-review job reopens from history (kind badge «Бэклог»)', async () => {
    listJobs.mockResolvedValue(HISTORY);
    getJob.mockResolvedValue({ ...REVIEW_JOB, jobId: 'job-h1' });
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');

    const history = await screen.findByTestId('ai-backlog-history');
    const kinds = within(history).getAllByTestId('ai-backlog-history-kind');
    expect(kinds[0]).toHaveTextContent('Бэклог');
    expect(kinds[1]).toHaveTextContent('Документация');
    const rows = within(history).getAllByTestId('ai-backlog-history-row');
    expect(rows[0]).toHaveTextContent('Ждёт выверки');

    await user.click(within(rows[0]!).getByTestId('ai-backlog-history-open'));
    expect(await screen.findByTestId('ai-backlog-review-step')).toBeInTheDocument();
    expect(screen.getByTestId('ai-backlog-selected-count')).toHaveTextContent('выбрано 3 из 4');
  });
});

describe('review edits (task25): name / parent node / target term', () => {
  async function openReview(user: ReturnType<typeof userEvent.setup>) {
    getJob.mockResolvedValue(REVIEW_JOB);
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);
    await screen.findByTestId('ai-backlog-review-step');
  }

  function row(rowId: string): HTMLElement {
    return screen
      .getAllByTestId('ai-backlog-review-row')
      .find((r) => r.getAttribute('data-rowid') === rowId)!;
  }

  it('renames the column to «Срок реализации» in the review table', async () => {
    const user = userEvent.setup();
    await openReview(user);
    const table = screen.getByTestId('ai-backlog-review-table');
    expect(within(table).getByText('Срок реализации')).toBeInTheDocument();
    expect(within(table).queryByText('Target')).not.toBeInTheDocument();
  });

  it('inline name edit: Enter saves, the row gets the «изменено» badge, apply carries the override', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    const input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.type(input, 'Граф коммитов{Enter}');

    expect(within(row('r1')).queryByTestId('ai-backlog-name-input')).not.toBeInTheDocument();
    expect(row('r1')).toHaveTextContent('Граф коммитов');
    expect(within(row('r1')).getByTestId('ai-backlog-row-edited')).toHaveTextContent('изменено');

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', {
      rowIds: ['r1', 'r2', 'r4'],
      overrides: { r1: { businessName: 'Граф коммитов' } },
    });
  });

  it('re-editing back to the original value (blur save) removes the override', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    let input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.type(input, 'Граф коммитов{Enter}');
    expect(within(row('r1')).getByTestId('ai-backlog-row-edited')).toBeInTheDocument();

    // Blur (a click elsewhere) also saves; the original value clears the edit.
    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.type(input, 'Визуализация графа коммитов');
    await user.click(screen.getByTestId('ai-backlog-selected-count'));

    expect(within(row('r1')).queryByTestId('ai-backlog-row-edited')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', { rowIds: ['r1', 'r2', 'r4'] });
  });

  it('Esc cancels the name edit without saving and keeps the modal open', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    const input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.type(input, 'Черновик{Escape}');

    expect(screen.getByTestId('ai-backlog-review-step')).toBeInTheDocument();
    expect(row('r1')).toHaveTextContent('Визуализация графа коммитов');
    expect(within(row('r1')).queryByTestId('ai-backlog-row-edited')).not.toBeInTheDocument();
  });

  it('an empty name is not saved: the input stays with a hint', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    const input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(within(row('r1')).getByTestId('ai-backlog-name-input')).toBeInTheDocument();
    expect(row('r1')).toHaveTextContent('Бизнес-имя не может быть пустым');
    expect(within(row('r1')).queryByTestId('ai-backlog-row-edited')).not.toBeInTheDocument();
  });

  it('parent picker: searches the existing nodes of the ROW type and reparents the row', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-parent'));
    const popover = await screen.findByTestId('ai-backlog-parent-popover');
    // r1 is a FUNCTION row — only the 2 FUNCTION nodes are offered.
    expect(within(popover).getAllByTestId('ai-backlog-parent-option')).toHaveLength(2);

    await user.type(within(popover).getByTestId('ai-backlog-parent-search'), 'поиск');
    const options = within(popover).getAllByTestId('ai-backlog-parent-option');
    expect(options).toHaveLength(1);
    // Orientation info: the node type and its own parent.
    expect(options[0]).toHaveTextContent('Поиск');
    expect(options[0]).toHaveTextContent('ФТ');
    expect(options[0]).toHaveTextContent('в «Работа с репозиторием»');

    await user.click(options[0]!);
    expect(screen.queryByTestId('ai-backlog-parent-popover')).not.toBeInTheDocument();
    expect(row('r1')).toHaveTextContent('Поиск');
    expect(within(row('r1')).getByTestId('ai-backlog-row-edited')).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', {
      rowIds: ['r1', 'r2', 'r4'],
      overrides: { r1: { parent: { kind: 'existing', name: 'Поиск' } } },
    });
  });

  it('parent picker: creates a new ROOT node with a custom name', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-parent'));
    const popover = await screen.findByTestId('ai-backlog-parent-popover');
    await user.type(
      within(popover).getByTestId('ai-backlog-parent-search'),
      'Интеграции с внешними системами',
    );
    const create = within(popover).getByTestId('ai-backlog-parent-create');
    expect(create).toHaveTextContent('Создать новый узел: «Интеграции с внешними системами»');
    await user.click(create);

    expect(row('r1')).toHaveTextContent('Интеграции с внешними системами');
    expect(within(row('r1')).getByTestId('ai-backlog-badge-new-node')).toBeInTheDocument();
    expect(within(row('r1')).getByTestId('ai-backlog-row-edited')).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', {
      rowIds: ['r1', 'r2', 'r4'],
      overrides: { r1: { parent: { kind: 'new', name: 'Интеграции с внешними системами' } } },
    });
  });

  it('«Вернуть предложенное» drops the parent edit back to the AI proposal', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-parent'));
    let popover = await screen.findByTestId('ai-backlog-parent-popover');
    // No edit yet — nothing to reset.
    expect(within(popover).queryByTestId('ai-backlog-parent-reset')).not.toBeInTheDocument();
    await user.type(within(popover).getByTestId('ai-backlog-parent-search'), 'поиск');
    await user.click(within(popover).getAllByTestId('ai-backlog-parent-option')[0]!);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-parent'));
    popover = await screen.findByTestId('ai-backlog-parent-popover');
    await user.click(within(popover).getByTestId('ai-backlog-parent-reset'));

    expect(row('r1')).toHaveTextContent('Работа с репозиторием');
    expect(within(row('r1')).queryByTestId('ai-backlog-row-edited')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', { rowIds: ['r1', 'r2', 'r4'] });
  });

  it('target edit: the 📄 marker gives way to «изменено», apply carries the quarter/year pair', async () => {
    const user = userEvent.setup();
    await openReview(user);

    // r4 has a file-provided term (Q1 2027) — override the quarter only.
    expect(within(row('r4')).getByTestId('ai-backlog-target-from-file')).toBeInTheDocument();
    await user.selectOptions(within(row('r4')).getByTestId('ai-backlog-target-quarter-cell'), 'Q3');

    expect(within(row('r4')).queryByTestId('ai-backlog-target-from-file')).not.toBeInTheDocument();
    expect(within(row('r4')).getByTestId('ai-backlog-row-edited')).toBeInTheDocument();
    expect(within(row('r4')).getByTestId('ai-backlog-row-target')).toHaveTextContent('изменено');

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', {
      rowIds: ['r1', 'r2', 'r4'],
      overrides: { r4: { targetQuarter: 'Q3', targetYear: 2027 } },
    });
  });

  it('an edit of a deselected row is NOT sent (overrides ⊆ rowIds)', async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(within(row('r1')).getByTestId('ai-backlog-edit-name'));
    const input = within(row('r1')).getByTestId('ai-backlog-name-input');
    await user.clear(input);
    await user.type(input, 'Граф коммитов{Enter}');
    await user.click(within(row('r1')).getByTestId('ai-backlog-row-checkbox'));

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(applyJob).toHaveBeenCalledWith('job-b1', { rowIds: ['r2', 'r4'] });
  });

  it('a 400 on apply (invalid override) is shown inline, the review step survives', async () => {
    applyJob.mockRejectedValue(
      new ApiError(400, {
        code: 'VALIDATION',
        message: 'Узел «Нет такого» не найден в дереве проекта (строка r1).',
      }),
    );
    const user = userEvent.setup();
    await openReview(user);

    await user.click(screen.getByTestId('ai-backlog-apply'));
    expect(await screen.findByTestId('ai-backlog-apply-error')).toHaveTextContent(
      'Узел «Нет такого» не найден',
    );
    expect(screen.getByTestId('ai-backlog-review-step')).toBeInTheDocument();
    expect(screen.getByTestId('ai-backlog-apply')).not.toBeDisabled();
  });

  it('a duplicate row offers no editors at all', async () => {
    const user = userEvent.setup();
    await openReview(user);

    const dupRow = row('r3');
    expect(within(dupRow).queryByTestId('ai-backlog-edit-name')).not.toBeInTheDocument();
    expect(within(dupRow).queryByTestId('ai-backlog-edit-parent')).not.toBeInTheDocument();
    expect(within(dupRow).queryByTestId('ai-backlog-target-quarter-cell')).not.toBeInTheDocument();
    expect(within(dupRow).queryByTestId('ai-backlog-target-year-cell')).not.toBeInTheDocument();
  });
});

describe('report (mockup 03) and errors', () => {
  it('renders the final counters, the mapping table with badges and usage', async () => {
    getJob.mockResolvedValue(SUCCEEDED_JOB);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    await screen.findByTestId('ai-backlog-success');
    expect(screen.getByTestId('ai-backlog-report-functions')).toHaveTextContent('2');
    expect(screen.getByTestId('ai-backlog-report-nfrs')).toHaveTextContent('1');
    expect(screen.getByTestId('ai-backlog-report-links')).toHaveTextContent('3');
    expect(screen.getByTestId('ai-backlog-report-new-nodes')).toHaveTextContent('1');
    expect(screen.getByTestId('ai-backlog-report-duplicates')).toHaveTextContent('1');

    const table = screen.getByTestId('ai-backlog-report-table');
    expect(within(table).getAllByTestId('ai-backlog-report-row')).toHaveLength(4);
    // task25: the report also carries the renamed «Срок реализации» column.
    expect(within(table).getByText('Срок реализации')).toBeInTheDocument();
    expect(within(table).getAllByTestId('ai-backlog-report-row')[0]).toHaveTextContent('Q4 2026');
    expect(within(table).getByTestId('ai-backlog-badge-duplicate')).toHaveTextContent('дубль');
    expect(within(table).getByTestId('ai-backlog-badge-nfr')).toHaveTextContent('НФТ');
    expect(within(table).getByTestId('ai-backlog-badge-new-node')).toHaveTextContent('новый узел');

    expect(screen.getByTestId('ai-backlog-usage')).toHaveTextContent('Потрачено токенов');
    expect(screen.getByTestId('ai-backlog-download-log')).toBeInTheDocument();
  });

  it('taxonomy failure reuses the todo_20 error blocks with «Продолжить» when resumable', async () => {
    getJob.mockResolvedValue({
      ...RUNNING_MATCH,
      status: 'failed',
      error: {
        message: 'Сервис AI не отвечает: запросы превышают тайм-аут.',
        hint: 'Повторите позже — прогресс сохранён.',
        code: 'NET-03',
        category: 'network',
        action: 'Повторите позже — прогресс сохранён.',
        resumable: true,
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    const card = await screen.findByTestId('ai-backlog-error');
    expect(card).toHaveTextContent('Сервис AI не отвечает');
    expect(screen.getByTestId('ai-backlog-error-code')).toHaveTextContent('NET-03');
    expect(screen.getByTestId('ai-backlog-error-details')).toHaveTextContent('category: network');

    await user.click(screen.getByTestId('ai-backlog-resume'));
    expect(resumeJob).toHaveBeenCalledWith('job-b1');
  });

  it('non-taxonomy failure keeps the plain message + retry', async () => {
    getJob.mockResolvedValue({
      ...RUNNING_MATCH,
      status: 'failed',
      error: { message: 'Файл не читается как xlsx.', hint: 'Проверьте выгрузку.' },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-backlog-model-select');
    await startJob(user);

    const err = await screen.findByTestId('ai-backlog-error');
    expect(err).toHaveTextContent('Файл не читается как xlsx.');
    expect(err).toHaveTextContent('Что делать: Проверьте выгрузку.');
    expect(screen.getByTestId('ai-backlog-retry')).toBeInTheDocument();
  });
});

describe('SourceType BACKLOG in the UI dictionaries (T-306, PO №4)', () => {
  it('label, icon and select order include BACKLOG after STANDARD', () => {
    expect(SOURCE_TYPE_LABEL.BACKLOG).toBe('Бэклог');
    expect(SOURCE_TYPE_ICON.BACKLOG).toBeDefined();
    expect(SOURCE_TYPES_ORDER.indexOf('BACKLOG')).toBe(SOURCE_TYPES_ORDER.indexOf('STANDARD') + 1);
    expect(SOURCE_TYPES_ORDER[SOURCE_TYPES_ORDER.length - 1]).toBe('TEXT');
  });
});
