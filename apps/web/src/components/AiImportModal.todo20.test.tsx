import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiImportJobSummary, AiImportJobView } from '@po/core';
import { AiImportModal, formatEta, formatTokens } from './AiImportModal';
import { renderWithProviders } from '../test/utils';

/**
 * todo_20 (T-214/T-215): estimate gate, content-rich progress, taxonomy
 * errors with ranked actions, resume, quality report and the run history.
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

/** П2: estimate over the threshold — the job waits on the confirmation gate. */
const ESTIMATE_JOB: AiImportJobView = {
  ...BASE_JOB,
  status: 'awaiting-confirmation',
  progress: 5,
  inventory: {
    totalFiles: 512,
    processed: { 'release-notes': 58, 'user-guide': 214, other: 104 },
    excluded: [
      { path: 'images/*.png', reason: 'изображения', count: 61 },
      { path: 'package-lock.json', reason: 'lock-файл', count: 1 },
    ],
  },
  estimate: {
    files: 376,
    chunks: 620,
    calls: 810,
    tokens: 9_300_000,
    thresholdTokens: 2_000_000,
    overThreshold: true,
  },
};

/** E3: running with the content-rich progress fields. */
const RICH_RUNNING: AiImportJobView = {
  ...BASE_JOB,
  currentFile: 'release-notes/rn-4.2.json',
  currentClass: 'release-notes',
  chunkIndex: 214,
  chunkTotal: 620,
  etaSeconds: 9600,
  usage: { promptTokens: 1_900_000, completionTokens: 1_200_000 },
  result: {
    createdFunctions: 293,
    createdNfrs: 41,
    skippedExisting: 0,
    links: 250,
    relatesLinks: 38,
  },
};

/** П6: taxonomy fail (NET-03) — resumable, with partial result. */
const TAXO_FAILED: AiImportJobView = {
  ...BASE_JOB,
  status: 'failed',
  chunkIndex: 215,
  chunkTotal: 620,
  currentFile: 'user-guide/branching.md',
  error: {
    message: 'Сервис AI не отвечает: запросы превышают тайм-аут, повторы не помогли.',
    hint: 'Увеличьте тайм-аут вызова в настройках модели или повторите позже — прогресс сохранён.',
    code: 'NET-03',
    category: 'network',
    action:
      'Увеличьте тайм-аут вызова в настройках модели или повторите позже — прогресс сохранён.',
    resumable: true,
  },
  result: {
    createdFunctions: 293,
    createdNfrs: 41,
    skippedExisting: 2,
    links: 250,
    relatesLinks: 38,
  },
};

/** П5.2: unfinished job discovered after a server restart. */
const INTERRUPTED_JOB: AiImportJobView = {
  ...BASE_JOB,
  status: 'interrupted',
  chunkIndex: 214,
  chunkTotal: 620,
  result: {
    createdFunctions: 293,
    createdNfrs: 41,
    skippedExisting: 0,
    links: 200,
    relatesLinks: 0,
  },
};

/** E4: succeeded with the quality report. */
const REPORTED_SUCCESS: AiImportJobView = {
  ...BASE_JOB,
  status: 'succeeded',
  stage: 'done',
  progress: 100,
  result: {
    createdFunctions: 642,
    createdNfrs: 87,
    skippedExisting: 3,
    links: 700,
    relatesLinks: 1,
  },
  usage: { promptTokens: 5_600_000, completionTokens: 3_500_000 },
  report: {
    coverage: [
      {
        sourceClass: 'release-notes',
        files: 58,
        processedFiles: 58,
        extractedFunctions: 402,
        extractedNfrs: 6,
        retriedChunks: 11,
      },
      {
        sourceClass: 'other',
        files: 613,
        processedFiles: 610,
        extractedFunctions: 7,
        extractedNfrs: 2,
        retriedChunks: 0,
      },
    ],
    blindSpots: [
      { kind: 'truncated', message: 'На части фрагментов ответ модели был обрезан', count: 17 },
    ],
  },
};

const HISTORY: { jobs: AiImportJobSummary[] } = {
  jobs: [
    {
      jobId: 'job-h1',
      projectId: 'proj-1',
      status: 'failed',
      startedAt: '2026-08-01T18:42:00.000Z',
      result: {
        createdFunctions: 293,
        createdNfrs: 41,
        skippedExisting: 0,
        links: 200,
        relatesLinks: 0,
      },
      resumable: true,
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

const archive = new File(['dummy-zip-bytes'], 'docs-portal.zip', { type: 'application/zip' });

function renderModal(onClose = vi.fn()) {
  const utils = renderWithProviders(<AiImportModal projectId="proj-1" onClose={onClose} />);
  return { ...utils, onClose };
}

async function startJob(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.upload(screen.getByTestId('ai-import-file'), archive);
  await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
  await user.click(screen.getByTestId('ai-import-start'));
  await screen.findByTestId('ai-import-log');
}

describe('AiImportModal (todo_20)', () => {
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

  describe('helpers', () => {
    it('formatTokens: millions with a ru comma, thousands, small numbers', () => {
      expect(formatTokens(9_300_000)).toBe('9,3 млн');
      expect(formatTokens(2_000_000)).toBe('2 млн');
      expect(formatTokens(96_000)).toBe('96 тыс.');
      expect(formatTokens(950)).toBe('950');
    });

    it('formatEta: hours+minutes, minutes, seconds', () => {
      expect(formatEta(9600)).toBe('≈ 2 ч 40 мин');
      expect(formatEta(320)).toBe('≈ 5 мин');
      expect(formatEta(40)).toBe('≈ 40 с');
    });
  });

  // ── П1+П2: the estimate gate (awaiting-confirmation) ───────────────────────

  describe('estimate step (awaiting-confirmation)', () => {
    it('renders the inventory by class, exclusions with reasons and the over-threshold warning', async () => {
      getJob.mockResolvedValue(ESTIMATE_JOB);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      const inventory = await screen.findByTestId('ai-import-inventory');
      expect(inventory).toHaveTextContent('Опись архива — 512 файлов');
      expect(screen.getByTestId('ai-import-inventory-release-notes')).toHaveTextContent('58');
      expect(screen.getByTestId('ai-import-inventory-release-notes')).toHaveTextContent(
        'Release notes',
      );
      expect(screen.getByTestId('ai-import-inventory-user-guide')).toHaveTextContent('214');
      expect(screen.getByTestId('ai-import-inventory-other')).toHaveTextContent('Прочее');
      // Classes with zero files render no card at all.
      expect(screen.queryByTestId('ai-import-inventory-security')).not.toBeInTheDocument();

      // Exclusions: always with a reason, under a collapsible summary (61+1=62).
      const excluded = screen.getByTestId('ai-import-excluded');
      expect(excluded).toHaveTextContent('Исключено из обработки — 62 файла');
      expect(excluded).toHaveTextContent('images/*.png');
      expect(excluded).toHaveTextContent('изображения — 61');

      // Over the threshold: the warning block with the estimate numbers.
      const warning = screen.getByTestId('ai-import-estimate-warning');
      expect(warning).toHaveTextContent('Оценка превышает порог подтверждения');
      expect(warning).toHaveTextContent('≈ 620');
      expect(warning).toHaveTextContent('≈ 810');
      expect(warning).toHaveTextContent('≈ 9,3 млн');
      expect(warning).toHaveTextContent('Порог: 2 млн токенов');
      // No plain-info estimate block and no progress bar on the gate.
      expect(screen.queryByTestId('ai-import-estimate')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ai-import-progress')).not.toBeInTheDocument();
    });

    it('«Запустить всё равно» confirms the job and switches to the running view', async () => {
      getJob.mockResolvedValue(ESTIMATE_JOB);
      confirmJob.mockResolvedValue({ ...ESTIMATE_JOB, status: 'running' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      const confirm = await screen.findByTestId('ai-import-confirm-start');
      expect(confirm).toHaveTextContent('Запустить всё равно');
      await user.click(confirm);
      expect(confirmJob).toHaveBeenCalledWith('job-1');
      // The confirmed view (running) lands in the cache → progress UI is back.
      expect(await screen.findByTestId('ai-import-stop')).toBeInTheDocument();
      expect(screen.getByTestId('ai-import-progress')).toBeInTheDocument();
    });

    it('below the threshold: info estimate block and a plain «Запустить импорт»', async () => {
      getJob.mockResolvedValue({
        ...ESTIMATE_JOB,
        estimate: {
          files: 376,
          chunks: 96,
          calls: 130,
          tokens: 1_400_000,
          thresholdTokens: 2_000_000,
          overThreshold: false,
        },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      const estimate = await screen.findByTestId('ai-import-estimate');
      expect(estimate).toHaveTextContent('Оценка прогона');
      expect(estimate).toHaveTextContent('В пределах порога подтверждения');
      expect(screen.queryByTestId('ai-import-estimate-warning')).not.toBeInTheDocument();
      expect(screen.getByTestId('ai-import-confirm-start')).toHaveTextContent('Запустить импорт');
    });

    it('«Отмена» on the gate cancels the job', async () => {
      getJob.mockResolvedValue(ESTIMATE_JOB);
      cancelJob.mockResolvedValue({ ...ESTIMATE_JOB, status: 'cancelled' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await user.click(await screen.findByTestId('ai-import-estimate-cancel'));
      expect(cancelJob).toHaveBeenCalledWith('job-1');
    });
  });

  // ── E3: progress with content ──────────────────────────────────────────────

  describe('content-rich progress', () => {
    it('shows «фрагмент X из Y», the current file/class, the ETA and the counters', async () => {
      getJob.mockResolvedValue(RICH_RUNNING);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      expect(screen.getByTestId('ai-import-chunk')).toHaveTextContent('фрагмент 214 из 620');
      // Terminology: «фрагмент», never «чанк».
      expect(screen.getByTestId('ai-import-chunk')).not.toHaveTextContent(/чанк/i);
      expect(screen.getByTestId('ai-import-current-file')).toHaveTextContent(
        'release-notes/rn-4.2.json',
      );
      expect(screen.getByTestId('ai-import-current')).toHaveTextContent('класс: Release notes');
      expect(screen.getByTestId('ai-import-eta')).toHaveTextContent('осталось ≈ 2 ч 40 мин');

      const counters = screen.getByTestId('ai-import-counters');
      expect(within(counters).getByTestId('ai-import-counter-functions')).toHaveTextContent('293');
      expect(within(counters).getByTestId('ai-import-counter-nfrs')).toHaveTextContent('41');
      // 250 CHILD_OF + 38 RELATES_TO = 288.
      expect(within(counters).getByTestId('ai-import-counter-links')).toHaveTextContent('288');
      expect(within(counters).getByTestId('ai-import-counter-tokens')).toHaveTextContent('3,1 млн');
      expect(within(counters).getByTestId('ai-import-counter-tokens')).toHaveTextContent(
        '1,9 млн / 1,2 млн',
      );
    });

    it('etaSeconds=null renders «оценивается…» (PO №6)', async () => {
      getJob.mockResolvedValue({ ...RICH_RUNNING, etaSeconds: null } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      expect(screen.getByTestId('ai-import-eta')).toHaveTextContent('осталось: оценивается…');
    });

    it('log can always be downloaded as a file', async () => {
      getJob.mockResolvedValue(RICH_RUNNING);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      expect(screen.getByTestId('ai-import-download-log')).toHaveAttribute(
        'href',
        '/api/ai-import/job-1/log',
      );
    });
  });

  // ── П6: taxonomy error with ranked actions ─────────────────────────────────

  describe('taxonomy error (failed)', () => {
    it('message first, code badge, action, created counters and collapsible details', async () => {
      getJob.mockResolvedValue(TAXO_FAILED);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      const error = await screen.findByTestId('ai-import-error');
      expect(error).toHaveTextContent(
        'Сервис AI не отвечает: запросы превышают тайм-аут, повторы не помогли.',
      );
      expect(within(error).getByTestId('ai-import-error-code')).toHaveTextContent(
        'Ошибка · NET-03',
      );
      expect(error).toHaveTextContent('Что сделать: Увеличьте тайм-аут вызова');

      // «Уже создано — ничего не потеряно»: counters + fragments passed.
      const created = screen.getByTestId('ai-import-error-created');
      expect(created).toHaveTextContent('ничего не потеряно');
      expect(created).toHaveTextContent('293');
      expect(created).toHaveTextContent('41');
      expect(created).toHaveTextContent('288'); // 250 + 38
      expect(created).toHaveTextContent('215/620');

      // Technical detail is collapsed, not in the first line.
      const details = screen.getByTestId('ai-import-error-details');
      expect(details).toHaveTextContent('code: NET-03 · category: network · resumable: true');
      expect(details).toHaveTextContent('file: user-guide/branching.md');
    });

    it('«Продолжить» resumes the job and returns to the running view', async () => {
      getJob.mockResolvedValueOnce(TAXO_FAILED).mockResolvedValue(RICH_RUNNING);
      resumeJob.mockResolvedValue({ jobId: 'job-1' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await user.click(await screen.findByTestId('ai-import-resume'));
      expect(resumeJob).toHaveBeenCalledWith('job-1');
      // The invalidated job query refetches: running again, stop available.
      expect(await screen.findByTestId('ai-import-stop')).toBeInTheDocument();
    });

    it('«Повторить с меньшими фрагментами» opens the how-to hint (settings → chunk size)', async () => {
      getJob.mockResolvedValue(TAXO_FAILED);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await screen.findByTestId('ai-import-error');
      expect(screen.queryByTestId('ai-import-smaller-chunks-hint')).not.toBeInTheDocument();
      await user.click(screen.getByTestId('ai-import-smaller-chunks'));
      const hint = screen.getByTestId('ai-import-smaller-chunks-hint');
      expect(hint).toHaveTextContent('Размер фрагмента (символов)');
      expect(hint).toHaveTextContent('экран AI');
      // Toggle off.
      await user.click(screen.getByTestId('ai-import-smaller-chunks'));
      expect(screen.queryByTestId('ai-import-smaller-chunks-hint')).not.toBeInTheDocument();
    });

    it('«Открыть частичный результат» closes the modal (the tree is behind it)', async () => {
      getJob.mockResolvedValue(TAXO_FAILED);
      const user = userEvent.setup();
      const { onClose } = renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await user.click(await screen.findByTestId('ai-import-open-partial'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('non-resumable error: no «Продолжить», the primary action is a retry', async () => {
      getJob.mockResolvedValue({
        ...TAXO_FAILED,
        result: undefined,
        error: {
          message: 'В архиве нет текстовых файлов документации.',
          hint: 'Добавьте в архив документацию (.md/.txt/.json/.yaml) и повторите.',
          code: 'DATA-01',
          category: 'data',
          action: 'Добавьте в архив документацию (.md/.txt/.json/.yaml) и повторите.',
          resumable: false,
        },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await screen.findByTestId('ai-import-error');
      expect(screen.queryByTestId('ai-import-resume')).not.toBeInTheDocument();
      // No result → no partial-result button either.
      expect(screen.queryByTestId('ai-import-open-partial')).not.toBeInTheDocument();
      expect(screen.getByTestId('ai-import-retry')).toHaveTextContent('Повторить анализ');
    });
  });

  // ── П5.2: interrupted job ──────────────────────────────────────────────────

  describe('interrupted job', () => {
    it('renders the restart banner with counters and resumes on «Продолжить»', async () => {
      getJob.mockResolvedValueOnce(INTERRUPTED_JOB).mockResolvedValue(RICH_RUNNING);
      resumeJob.mockResolvedValue({ jobId: 'job-1' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      const panel = await screen.findByTestId('ai-import-interrupted');
      expect(panel).toHaveTextContent('Прогон прерван перезапуском сервера');
      expect(panel).toHaveTextContent('фрагмент 214 из 620');
      expect(panel).toHaveTextContent('293 ФТ');
      expect(panel).toHaveTextContent('пройденные фрагменты повторно не оплачиваются');

      await user.click(screen.getByTestId('ai-import-resume'));
      expect(resumeJob).toHaveBeenCalledWith('job-1');
      expect(await screen.findByTestId('ai-import-stop')).toBeInTheDocument();
    });
  });

  // ── E4: quality report ─────────────────────────────────────────────────────

  describe('quality report', () => {
    it('succeeded: coverage table, blind spots and the token usage', async () => {
      getJob.mockResolvedValue(REPORTED_SUCCESS);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      const coverage = screen.getByTestId('ai-import-report-coverage');
      const rnRow = within(coverage).getByTestId('ai-import-coverage-release-notes');
      expect(rnRow).toHaveTextContent('Release notes');
      expect(rnRow).toHaveTextContent('58 / 58');
      expect(rnRow).toHaveTextContent('402 / 6');
      expect(rnRow).toHaveTextContent('11');
      expect(within(coverage).getByTestId('ai-import-coverage-other')).toHaveTextContent(
        '610 / 613',
      );

      const blind = screen.getByTestId('ai-import-blindspots');
      expect(blind).toHaveTextContent('Обратите внимание');
      expect(blind).toHaveTextContent('ответ модели был обрезан — 17');

      expect(screen.getByTestId('ai-import-usage')).toHaveTextContent(
        'Потрачено токенов: 9,1 млн (5,6 млн запросы / 3,5 млн ответы)',
      );
    });

    it('failed: the (partial) report is still rendered', async () => {
      getJob.mockResolvedValue({
        ...TAXO_FAILED,
        report: REPORTED_SUCCESS.report,
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');
      await startJob(user);

      await screen.findByTestId('ai-import-error');
      expect(screen.getByTestId('ai-import-report')).toBeInTheDocument();
      expect(screen.getByTestId('ai-import-blindspots')).toBeInTheDocument();
    });
  });

  // ── PO №4: run history of the project ──────────────────────────────────────

  describe('run history', () => {
    it('lists past runs with status, date and counters; log is a download link', async () => {
      listJobs.mockResolvedValue(HISTORY);
      renderModal();
      await screen.findByTestId('ai-import-model-select');

      const history = await screen.findByTestId('ai-import-history');
      expect(history).toHaveTextContent('Прошлые прогоны — 2');
      const rows = screen.getAllByTestId('ai-import-history-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('Ошибка');
      expect(rows[0]).toHaveTextContent('293 ФТ · 41 НФТ');
      expect(rows[1]).toHaveTextContent('Завершён');
      expect(rows[1]).toHaveTextContent('642 ФТ · 87 НФТ');
      expect(within(rows[0]).getByTestId('ai-import-history-log')).toHaveAttribute(
        'href',
        '/api/ai-import/job-h1/log',
      );
      // Only the resumable run offers «Продолжить».
      expect(within(rows[0]).getByTestId('ai-import-history-resume')).toBeInTheDocument();
      expect(within(rows[1]).queryByTestId('ai-import-history-resume')).not.toBeInTheDocument();
    });

    it('«Открыть» shows the past run (report) inside the modal', async () => {
      listJobs.mockResolvedValue(HISTORY);
      getJob.mockResolvedValue({ ...REPORTED_SUCCESS, jobId: 'job-h2' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');

      const rows = await screen.findAllByTestId('ai-import-history-row');
      await user.click(within(rows[1]).getByTestId('ai-import-history-open'));
      expect(getJob).toHaveBeenCalledWith('job-h2');
      await screen.findByTestId('ai-import-success');
      expect(screen.getByTestId('ai-import-report')).toBeInTheDocument();
    });

    it('«Продолжить» on a history row resumes that job and starts polling it', async () => {
      listJobs.mockResolvedValue(HISTORY);
      resumeJob.mockResolvedValue({ jobId: 'job-h1' });
      getJob.mockResolvedValue({ ...RICH_RUNNING, jobId: 'job-h1' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');

      const rows = await screen.findAllByTestId('ai-import-history-row');
      await user.click(within(rows[0]).getByTestId('ai-import-history-resume'));
      expect(resumeJob).toHaveBeenCalledWith('job-h1');
      // The modal switches to the resumed job's live progress.
      expect(await screen.findByTestId('ai-import-stop')).toBeInTheDocument();
      expect(getJob).toHaveBeenCalledWith('job-h1');
    });

    it('an interrupted run in the history surfaces the restart banner with resume', async () => {
      listJobs.mockResolvedValue({
        jobs: [
          {
            jobId: 'job-h3',
            projectId: 'proj-1',
            status: 'interrupted',
            startedAt: '2026-08-02T18:42:00.000Z',
            resumable: true,
          } satisfies AiImportJobSummary,
        ],
      });
      resumeJob.mockResolvedValue({ jobId: 'job-h3' });
      getJob.mockResolvedValue({ ...RICH_RUNNING, jobId: 'job-h3' });
      const user = userEvent.setup();
      renderModal();
      await screen.findByTestId('ai-import-model-select');

      const banner = await screen.findByTestId('ai-import-interrupted-banner');
      expect(banner).toHaveTextContent('Найден незавершённый AI-импорт');
      expect(banner).toHaveTextContent('прерван перезапуском сервера');

      await user.click(screen.getByTestId('ai-import-interrupted-resume'));
      expect(resumeJob).toHaveBeenCalledWith('job-h3');
      expect(await screen.findByTestId('ai-import-stop')).toBeInTheDocument();
    });
  });
});
