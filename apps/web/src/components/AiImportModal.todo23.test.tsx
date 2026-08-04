import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiImportJobView } from '@po/core';
import { AiImportModal } from './AiImportModal';
import { renderWithProviders } from '../test/utils';

/**
 * todo_23 · M3: honest extracted-but-not-yet-created counters.
 * The job view / result carry OPTIONAL `extractedFunctions` / `extractedNfrs`
 * (live during `running` from the analyze stage, incl. resume). The modal:
 *  - running: shows «извлечено (ждёт записи): N ФТ, M НФТ» next to the
 *    created-counters (`ai-import-extracted`), only when the fields are
 *    present and their sum > 0;
 *  - cancelled / failed (taxonomy): when extracted > created, adds the line
 *    «Извлечено X ФТ и Y НФТ — сохранены в контрольной точке…»;
 *  - old jobs without the fields render nothing new (zero regressions).
 */

const getConfig = vi.fn();
const listModels = vi.fn();
const startImport = vi.fn();
const getJob = vi.fn();
const cancelJob = vi.fn();
const confirmJob = vi.fn();
const resumeJob = vi.fn();
const listJobs = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {},
  requirementsApi: {},
  linksApi: {},
  aiApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    listModels: (...a: unknown[]) => listModels(...a),
  },
  aiImportApi: {
    start: (...a: unknown[]) => startImport(...a),
    getJob: (...a: unknown[]) => getJob(...a),
    cancel: (...a: unknown[]) => cancelJob(...a),
    confirm: (...a: unknown[]) => confirmJob(...a),
    resume: (...a: unknown[]) => resumeJob(...a),
    listJobs: (...a: unknown[]) => listJobs(...a),
    logUrl: (jobId: string) => `/api/ai-import/${jobId}/log`,
  },
}));

const CONFIGURED = {
  baseURL: 'https://api.ai.sbt/openai/v1',
  hasApiKey: true,
  model: 'GigaChat-2-Pro',
};
const MODELS = { models: ['GigaChat-2-Pro', 'Qwen-Coder-Next'] };

const BASE_JOB: AiImportJobView = {
  jobId: 'job-1',
  projectId: 'proj-1',
  status: 'running',
  stage: 'analyze',
  progress: 34,
  log: [{ ts: '2026-08-01T12:01:03.000Z', level: 'info', message: 'Архив распакован' }],
};

/** The pilot-log scenario: 89 minutes, 881+156 extracted, 0 created yet. */
const RUNNING_EXTRACTED: AiImportJobView = {
  ...BASE_JOB,
  extractedFunctions: 881,
  extractedNfrs: 156,
  result: {
    createdFunctions: 0,
    createdNfrs: 0,
    skippedExisting: 0,
    links: 0,
    relatesLinks: 0,
  },
};

const CANCELLED_EXTRACTED: AiImportJobView = {
  ...BASE_JOB,
  status: 'cancelled',
  result: {
    createdFunctions: 0,
    createdNfrs: 0,
    skippedExisting: 0,
    links: 0,
    relatesLinks: 0,
    extractedFunctions: 881,
    extractedNfrs: 156,
  },
};

/** Taxonomy fail (NET-03, resumable) with extracted > created. */
const FAILED_EXTRACTED: AiImportJobView = {
  ...BASE_JOB,
  status: 'failed',
  error: {
    message: 'Сервис AI не отвечает: запросы превышают тайм-аут, повторы не помогли.',
    hint: 'Повторите позже — прогресс сохранён.',
    code: 'NET-03',
    category: 'network',
    action: 'Повторите позже — прогресс сохранён.',
    resumable: true,
  },
  result: {
    createdFunctions: 293,
    createdNfrs: 41,
    skippedExisting: 0,
    links: 250,
    relatesLinks: 0,
  },
  extractedFunctions: 881,
  extractedNfrs: 156,
};

const archive = new File(['dummy-zip-bytes'], 'docs-portal.zip', { type: 'application/zip' });

function renderModal(onClose = vi.fn()) {
  const utils = renderWithProviders(<AiImportModal projectId="proj-1" onClose={onClose} />);
  return { ...utils, onClose };
}

/** Upload the archive and press «Начать анализ» — the modal starts polling. */
async function startJob(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByTestId('ai-import-model-select');
  await user.upload(screen.getByTestId('ai-import-file'), archive);
  await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
  await user.click(screen.getByTestId('ai-import-start'));
}

describe('AiImportModal (todo_23 M3: extracted counters)', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIGURED);
    listModels.mockReset().mockResolvedValue(MODELS);
    startImport.mockReset().mockResolvedValue({ jobId: 'job-1' });
    getJob.mockReset();
    cancelJob.mockReset();
    confirmJob.mockReset();
    resumeJob.mockReset();
    listJobs.mockReset().mockResolvedValue({ jobs: [] });
  });

  it('running: shows «извлечено (ждёт записи)» with live top-level counters', async () => {
    getJob.mockResolvedValue(RUNNING_EXTRACTED);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    const extracted = await screen.findByTestId('ai-import-extracted');
    expect(extracted).toHaveTextContent('извлечено (ждёт записи)');
    expect(screen.getByTestId('ai-import-extracted-functions')).toHaveTextContent('881');
    expect(screen.getByTestId('ai-import-extracted-nfrs')).toHaveTextContent('156');
    // The created-counters stay honest next to it (0 created so far).
    expect(screen.getByTestId('ai-import-counter-functions')).toHaveTextContent('создано ФТ');
  });

  it('cancelled with extracted > created: checkpoint line inside the stop panel', async () => {
    getJob.mockResolvedValue(CANCELLED_EXTRACTED);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-cancelled-summary');
    const extracted = screen.getByTestId('ai-import-extracted');
    expect(extracted).toHaveTextContent(
      'Извлечено 881 ФТ и 156 НФТ — сохранены в контрольной точке, «Продолжить» доведёт до создания.',
    );
  });

  it('cancelled with extracted > created: «Продолжить» in the footer resumes the job', async () => {
    getJob.mockResolvedValue(CANCELLED_EXTRACTED);
    resumeJob.mockResolvedValue({ jobId: 'job-1' });
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-cancelled-summary');
    // The promised action exists: primary resume next to the secondary retry.
    const resume = screen.getByTestId('ai-import-resume');
    expect(resume).toHaveTextContent('Продолжить');
    expect(screen.getByTestId('ai-import-retry')).toHaveTextContent('Повторить анализ');
    expect(screen.getByTestId('ai-import-done')).toHaveTextContent('Готово');

    await user.click(resume);
    await waitFor(() => expect(resumeJob).toHaveBeenCalledWith('job-1'));
  });

  it('cancelled without extracted fields: no «Продолжить» — old footer intact', async () => {
    getJob.mockResolvedValue({
      ...BASE_JOB,
      status: 'cancelled',
      result: {
        createdFunctions: 5,
        createdNfrs: 1,
        skippedExisting: 0,
        links: 4,
        relatesLinks: 0,
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-cancelled-summary');
    expect(screen.queryByTestId('ai-import-resume')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-import-retry')).toBeInTheDocument();
    expect(screen.getByTestId('ai-import-done')).toBeInTheDocument();
  });

  it('failed (taxonomy) with extracted > created: checkpoint line, «Продолжить» not duplicated', async () => {
    getJob.mockResolvedValue(FAILED_EXTRACTED);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-error');
    const extracted = screen.getByTestId('ai-import-extracted');
    expect(extracted).toHaveTextContent('Извлечено 881 ФТ и 156 НФТ');
    expect(extracted).toHaveTextContent('сохранены в контрольной точке');
    // Exactly one resume button — the footer one that already existed.
    expect(screen.getAllByRole('button', { name: 'Продолжить' })).toHaveLength(1);
  });

  it('cancelled with extracted == created: no checkpoint line', async () => {
    getJob.mockResolvedValue({
      ...CANCELLED_EXTRACTED,
      result: {
        createdFunctions: 881,
        createdNfrs: 156,
        skippedExisting: 0,
        links: 10,
        relatesLinks: 0,
        extractedFunctions: 881,
        extractedNfrs: 156,
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-cancelled-summary');
    expect(screen.queryByTestId('ai-import-extracted')).not.toBeInTheDocument();
  });

  it('old job without the fields (running): renders nothing new', async () => {
    getJob.mockResolvedValue({
      ...BASE_JOB,
      result: {
        createdFunctions: 5,
        createdNfrs: 1,
        skippedExisting: 0,
        links: 4,
        relatesLinks: 0,
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-counters');
    expect(screen.queryByTestId('ai-import-extracted')).not.toBeInTheDocument();
  });

  it('old cancelled job without the fields: stop panel unchanged', async () => {
    getJob.mockResolvedValue({
      ...BASE_JOB,
      status: 'cancelled',
      result: {
        createdFunctions: 5,
        createdNfrs: 1,
        skippedExisting: 0,
        links: 4,
        relatesLinks: 0,
      },
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await startJob(user);

    await screen.findByTestId('ai-import-cancelled-summary');
    expect(screen.queryByTestId('ai-import-extracted')).not.toBeInTheDocument();
  });
});
