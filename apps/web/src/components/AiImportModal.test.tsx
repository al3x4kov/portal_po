import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiImportJobView } from '@po/core';
import { AiImportModal } from './AiImportModal';
import { renderWithProviders } from '../test/utils';
import { queryKeys } from '../api/hooks';
import { ApiError } from '../api/client';

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
const NOT_CONFIGURED = { baseURL: '', hasApiKey: false };
const MODELS = { models: ['GigaChat-2-Pro', 'Qwen-Coder-Next'] };

const RUNNING_JOB: AiImportJobView = {
  jobId: 'job-1',
  projectId: 'proj-1',
  status: 'running',
  stage: 'analyze',
  progress: 42,
  log: [
    { ts: '2026-07-04T12:01:03.000Z', level: 'info', message: 'Архив распакован: 23 файла (.md)' },
    { ts: '2026-07-04T12:01:22.000Z', level: 'warn', message: 'api.md (3/3) — чанк пропущен' },
  ],
};

const SUCCEEDED_JOB: AiImportJobView = {
  ...RUNNING_JOB,
  status: 'succeeded',
  stage: 'done',
  progress: 100,
  result: { createdFunctions: 18, createdNfrs: 6, skippedExisting: 3, links: 9, relatesLinks: 2 },
};

const FAILED_JOB: AiImportJobView = {
  ...RUNNING_JOB,
  status: 'failed',
  stage: 'analyze',
  progress: 47,
  error: {
    message: 'AI Hub недоступен: превышено время ожидания ответа.',
    hint: 'Проверьте доступность AI Hub, корректность API-ключа и повторите анализ',
  },
};

const CANCELLED_JOB: AiImportJobView = {
  ...RUNNING_JOB,
  status: 'cancelled',
  stage: 'analyze',
  progress: 55,
  result: { createdFunctions: 2, createdNfrs: 0, skippedExisting: 0, links: 0, relatesLinks: 0 },
};

const archive = new File(['dummy-zip-bytes'], 'docs-portal.zip', { type: 'application/zip' });

function renderModal(onClose = vi.fn()) {
  const utils = renderWithProviders(<AiImportModal projectId="proj-1" onClose={onClose} />);
  return { ...utils, onClose };
}

async function uploadArchive(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.upload(screen.getByTestId('ai-import-file'), archive);
}

/** Upload + start with a running job already mocked; waits for the job view. */
async function startJob(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await uploadArchive(user);
  await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
  await user.click(screen.getByTestId('ai-import-start'));
  await screen.findByTestId('ai-import-log');
}

describe('AiImportModal (Task 11)', () => {
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

  /** The disabled placeholder select is swapped for the live one once the AI
   *  config arrives — always re-query instead of holding on to the element. */
  async function waitForProjectModel(): Promise<HTMLElement> {
    await waitFor(() =>
      expect(screen.getByTestId('ai-import-model-select')).toHaveValue('GigaChat-2-Pro'),
    );
    return screen.getByTestId('ai-import-model-select');
  }

  it('without a file: start disabled with the reason, model defaults to the project model', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await waitForProjectModel();
    const start = screen.getByTestId('ai-import-start');
    expect(start).toBeDisabled();
    expect(start).toHaveTextContent('Начать анализ');
    expect(start).toHaveAttribute('title', 'Загрузите архив документации');
    // §3 (pattern 1): the disabled reason is also plain text left of the button.
    expect(screen.getByTestId('ai-import-footer-hint')).toHaveTextContent(
      'Загрузите архив документации',
    );
    expect(screen.getByTestId('ai-import-drop')).toBeInTheDocument();
    // «Отмена» in the setup footer closes without confirmation.
    await user.click(screen.getByTestId('ai-import-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('without an API key: select disabled with hint, start disabled with «Настройте AI Hub»', async () => {
    getConfig.mockResolvedValue(NOT_CONFIGURED);
    const user = userEvent.setup();
    renderModal();
    const select = await screen.findByTestId('ai-import-model-select');
    await waitFor(() => expect(select).toBeDisabled());
    expect(select).toHaveTextContent('Модель не настроена');
    expect(screen.getByTestId('ai-import-model-hint')).toHaveAttribute(
      'title',
      expect.stringContaining('Задайте API-ключ'),
    );
    expect(listModels).not.toHaveBeenCalled();

    // With a file chosen the blocker is now the missing AI Hub config.
    await uploadArchive(user);
    const start = screen.getByTestId('ai-import-start');
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Настройте AI Hub');
  });

  it('selecting a file shows its name and size and enables the start button', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await uploadArchive(user);

    const fileName = await screen.findByTestId('ai-import-file-name');
    expect(fileName).toHaveTextContent('docs-portal.zip');
    expect(fileName).toHaveTextContent('Б'); // formatted size
    expect(screen.getByTestId('ai-import-replace')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
    expect(screen.getByTestId('ai-import-footer-hint')).toHaveTextContent(
      'Файл выбран — можно начинать',
    );
  });

  it('start sends the file and the model override to the API', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    renderModal();
    await waitForProjectModel();
    // The option list is filled once GET /api/ai/models resolves.
    await screen.findByRole('option', { name: 'Qwen-Coder-Next' });
    await user.selectOptions(screen.getByTestId('ai-import-model-select'), 'Qwen-Coder-Next');
    await startJob(user);
    expect(startImport).toHaveBeenCalledWith('proj-1', archive, 'Qwen-Coder-Next');
  });

  it('start without an override leaves the model to the server (project model)', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    renderModal();
    await waitForProjectModel();
    await startJob(user);
    expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined);
  });

  it('surfaces a start error (e.g. 409 already running) in the setup view', async () => {
    startImport.mockRejectedValue(new Error('Импорт уже выполняется для этого проекта'));
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await uploadArchive(user);
    await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
    await user.click(screen.getByTestId('ai-import-start'));
    expect(await screen.findByTestId('ai-import-start-error')).toHaveTextContent(
      'Импорт уже выполняется',
    );
  });

  it('running: renders stage, progress % and the log; stop goes through a mini-confirm', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    cancelJob.mockResolvedValue(CANCELLED_JOB);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    expect(screen.getByTestId('ai-import-stage')).toHaveTextContent('Этап: Извлечение требований');
    expect(screen.getByTestId('ai-import-progress-pct')).toHaveTextContent('42%');
    expect(screen.getByTestId('ai-import-progress')).toHaveAttribute('aria-valuenow', '42');
    const log = screen.getByTestId('ai-import-log');
    expect(log).toHaveTextContent('Архив распакован: 23 файла (.md)');
    expect(log).toHaveTextContent('warn api.md (3/3) — чанк пропущен');

    // §2.18.1: «Остановить» is NOT instant — the mini-confirm opens first.
    await user.click(screen.getByTestId('ai-import-stop'));
    expect(cancelJob).not.toHaveBeenCalled();
    const confirm = await screen.findByTestId('ai-import-stop-confirm');
    expect(confirm).toHaveTextContent('Остановить анализ?');
    expect(confirm).toHaveTextContent('Созданное останется');

    await user.click(screen.getByTestId('ai-import-stop-confirm-confirm'));
    expect(cancelJob).toHaveBeenCalledWith('job-1');
    // The cancelled view keeps the log; retry is available right away.
    expect(await screen.findByTestId('ai-import-cancelled')).toHaveTextContent('Остановлено');
    expect(screen.getByTestId('ai-import-log')).toBeInTheDocument();
    expect(screen.getByTestId('ai-import-retry')).toHaveTextContent('Повторить анализ');
    expect(screen.getByTestId('ai-import-done')).toHaveTextContent('Готово');
  });

  it('task24: opens as a large modal; the log stretches into the free height (a11y kept)', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    renderModal();
    // Large size is set on the Modal shell already in the setup view.
    const card = screen.getByTestId('ai-import');
    expect(card.className).toContain('md:w-[70vw]');
    expect(card.className).toContain('md:h-[max(70vh,min(640px,80vh))]');
    // Mobile behaviour unchanged: base classes are the old ones.
    expect(card.className).toContain('w-full');
    expect(card.className).toContain('max-w-[640px]');

    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    // The log panel absorbs the remaining height instead of a fixed 170px…
    const panel = screen.getByTestId('ai-import-log-panel');
    expect(panel.className).toContain('flex-1');
    const log = screen.getByTestId('ai-import-log');
    // …guaranteed ≥300px on desktop (shrink-0 basis), growing with free space…
    expect(log.className).toContain('grow');
    expect(log.className).toContain('shrink-0');
    expect(log.className).toContain('md:basis-[300px]');
    // …and never collapsing below the old 170px on mobile; no inline height.
    expect(log.className).toContain('basis-[170px]');
    expect(log.className).toContain('min-h-[170px]');
    expect(log.style.height).toBe('');
    // a11y contract survives the resize (axe scrollable-region-focusable).
    expect(log).toHaveAttribute('role', 'log');
    expect(log).toHaveAttribute('tabindex', '0');
    expect(log).toHaveAttribute('aria-label', 'Журнал анализа');
  });

  it('stop mini-confirm: «Продолжить анализ» keeps the job running', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    await user.click(screen.getByTestId('ai-import-stop'));
    await screen.findByTestId('ai-import-stop-confirm');
    await user.click(screen.getByTestId('ai-import-stop-confirm-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('ai-import-stop-confirm')).not.toBeInTheDocument(),
    );
    expect(cancelJob).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-import-stop')).toBeInTheDocument();
  });

  it('running on the structure stage: shows the tree-building label (Task 13)', async () => {
    getJob.mockResolvedValue({
      ...RUNNING_JOB,
      stage: 'structure',
      progress: 70,
      log: [
        ...RUNNING_JOB.log,
        {
          ts: '2026-07-04T12:02:00.000Z',
          level: 'info',
          message: 'Построение древовидной структуры ФТ/НФТ через AI hub…',
        },
      ],
    } satisfies AiImportJobView);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    expect(screen.getByTestId('ai-import-stage')).toHaveTextContent(
      'Этап: Построение древовидной структуры ФТ/НФТ',
    );
    expect(screen.getByTestId('ai-import-progress-pct')).toHaveTextContent('70%');
    // The log under the progress bar keeps rendering as before.
    expect(screen.getByTestId('ai-import-log')).toHaveTextContent(
      'Построение древовидной структуры ФТ/НФТ через AI hub…',
    );
  });

  it('polling refreshes the job view until it succeeds', async () => {
    getJob.mockResolvedValueOnce(RUNNING_JOB).mockResolvedValue(SUCCEEDED_JOB);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    expect(screen.getByTestId('ai-import-progress-pct')).toHaveTextContent('42%');
    // Next poll (~800 ms) flips the job to succeeded.
    expect(await screen.findByTestId('ai-import-success', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByTestId('ai-import-progress-pct')).toHaveTextContent('100%');
    expect(getJob.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('running + ✕ opens the confirm; «Продолжить анализ» keeps the job alive', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    await user.click(screen.getByTestId('ai-import-close'));
    const confirm = await screen.findByTestId('ai-import-confirm');
    expect(confirm).toHaveTextContent('Прекратить автоматизацию?');
    expect(confirm).toHaveTextContent('Анализ документации ещё выполняется');
    // Stop-the-job confirmation shows a Lucide stop icon (no emoji, no trash can).
    const icon = screen.getByTestId('ai-import-confirm-icon');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon).toHaveTextContent('');

    await user.click(screen.getByTestId('ai-import-confirm-cancel')); // «Продолжить анализ»
    await waitFor(() => expect(screen.queryByTestId('ai-import-confirm')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-import-stop')).toBeInTheDocument();
  });

  it('running + ✕ → «Остановить и закрыть» cancels the job and closes the modal', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    cancelJob.mockResolvedValue(CANCELLED_JOB);
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    await user.click(screen.getByTestId('ai-import-close'));
    await user.click(await screen.findByTestId('ai-import-confirm-confirm'));
    expect(cancelJob).toHaveBeenCalledWith('job-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('running + overlay click also asks for confirmation', async () => {
    getJob.mockResolvedValue(RUNNING_JOB);
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    await user.click(screen.getByTestId('ai-import-overlay'));
    expect(await screen.findByTestId('ai-import-confirm')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('idle: ✕ and overlay click close immediately without confirmation', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('ai-import-model-select');

    await user.click(screen.getByTestId('ai-import-overlay'));
    expect(screen.queryByTestId('ai-import-confirm')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('ai-import-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('succeeded: summary table with totals, invalidates requirements, «Готово» closes', async () => {
    getJob.mockResolvedValue(SUCCEEDED_JOB);
    const user = userEvent.setup();
    const { onClose, queryClient } = renderModal();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    const success = await screen.findByTestId('ai-import-success');
    expect(success).toHaveTextContent('Анализ завершён');
    // §2.18.3: the summary is a table of rows with big numbers.
    const summary = screen.getByTestId('ai-import-summary');
    const rows = summary.querySelectorAll('tr');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Создано функциональных требований');
    expect(rows[0]).toHaveTextContent('18');
    expect(rows[1]).toHaveTextContent('Создано нефункциональных требований');
    expect(rows[1]).toHaveTextContent('6');
    expect(rows[2]).toHaveTextContent('Создано связей в дереве');
    expect(screen.getByTestId('ai-import-tree-links')).toHaveTextContent('9');
    expect(rows[3]).toHaveTextContent('Смысловые связи НФТ↔ФТ');
    // Task 15 / todo_18: NFR↔FT RELATES_TO counter keeps its own testid.
    // Without a relate step it equals the extraction-time count (2 + 0).
    expect(screen.getByTestId('ai-import-relates-links')).toHaveTextContent('2');
    expect(rows[4]).toHaveTextContent('Пропущено');
    expect(rows[4]).toHaveTextContent('уже существовали в проекте');
    expect(rows[4]).toHaveTextContent('3');
    // Task 13 A1: «Источник» stays EMPTY on import — the hint must point to the
    // analysis log, not to the business field.
    expect(success).toHaveTextContent(
      'Из какого файла взято каждое требование — указано в журнале анализа.',
    );
    expect(success).not.toHaveTextContent('поле «Источник»');

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.requirements('proj-1') }),
    );

    // §2.18.2: the success button is a plain «Готово» — no promised navigation.
    const done = screen.getByTestId('ai-import-done');
    expect(done).toHaveTextContent('Готово');
    await user.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('failed: shows the stage, message and the «Что делать» hint; retry returns to setup', async () => {
    getJob.mockResolvedValue(FAILED_JOB);
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    const error = await screen.findByTestId('ai-import-error');
    expect(error).toHaveTextContent('Ошибка на этапе „Извлечение требований“');
    expect(error).toHaveTextContent('AI Hub недоступен: превышено время ожидания ответа.');
    expect(error).toHaveTextContent(
      'Что делать: Проверьте доступность AI Hub, корректность API-ключа и повторите анализ',
    );

    // «Повторить анализ» → back to the file-selected setup, archive kept.
    await user.click(screen.getByTestId('ai-import-retry'));
    expect(await screen.findByTestId('ai-import-file-name')).toHaveTextContent('docs-portal.zip');
    expect(screen.getByTestId('ai-import-start')).not.toBeDisabled();
    expect(screen.queryByTestId('ai-import-error')).not.toBeInTheDocument();
  });

  // ── todo_16 A3: re-request the model list, re-pick a model at any time ─────

  describe('model list refresh (A3)', () => {
    it('re-requests the list on click and keeps the selection', async () => {
      listModels
        .mockResolvedValueOnce(MODELS)
        .mockResolvedValue({ models: [...MODELS.models, 'GigaChat-3'] });
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await screen.findByRole('option', { name: 'Qwen-Coder-Next' });
      await user.selectOptions(screen.getByTestId('ai-import-model-select'), 'Qwen-Coder-Next');

      await user.click(screen.getByTestId('ai-models-refresh-import'));
      await screen.findByRole('option', { name: 'GigaChat-3' });
      expect(listModels).toHaveBeenCalledTimes(2);
      // The selection survives the refresh; no notice is shown.
      expect(screen.getByTestId('ai-import-model-select')).toHaveValue('Qwen-Coder-Next');
      expect(screen.queryByTestId('ai-models-notice-import')).not.toBeInTheDocument();
    });

    it('vanished selection resets to the project model; the next run uses it', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      listModels.mockResolvedValueOnce(MODELS).mockResolvedValue({ models: ['GigaChat-2-Pro'] });
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await screen.findByRole('option', { name: 'Qwen-Coder-Next' });
      await user.selectOptions(screen.getByTestId('ai-import-model-select'), 'Qwen-Coder-Next');

      await user.click(screen.getByTestId('ai-models-refresh-import'));
      await waitFor(() =>
        expect(screen.getByTestId('ai-import-model-select')).toHaveValue('GigaChat-2-Pro'),
      );
      const notice = screen.getByTestId('ai-models-notice-import');
      expect(notice).toHaveTextContent('Qwen-Coder-Next');
      expect(notice).toHaveTextContent('GigaChat-2-Pro');

      // Starting the import now sends the auto-picked model.
      await startJob(user);
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, 'GigaChat-2-Pro');
    });

    it('refresh failure shows an inline error and keeps the selection', async () => {
      listModels
        .mockResolvedValueOnce(MODELS)
        .mockRejectedValue(new Error('AI Hub недоступен (502)'));
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();

      await user.click(screen.getByTestId('ai-models-refresh-import'));
      const notice = await screen.findByTestId('ai-models-notice-import');
      expect(notice).toHaveTextContent('Не удалось обновить список моделей');
      expect(notice).toHaveTextContent('502');
      expect(screen.getByTestId('ai-import-model-select')).toHaveValue('GigaChat-2-Pro');
    });
  });

  // ── todo_16 B2: optional AI relate step (связи ФТ↔НФТ) ─────────────────────

  describe('AI relate step (B2)', () => {
    it('checkbox is off by default and the start call omits inferLinks (pre-B2 shape)', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      expect(screen.getByTestId('ai-import-infer-links')).not.toBeChecked();
      await startJob(user);
      // Exactly the old 3-argument shape — no inferLinks argument at all.
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined);
    });

    it('enabled checkbox sends inferLinks=true with the start request', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await user.click(screen.getByTestId('ai-import-infer-links'));
      expect(screen.getByTestId('ai-import-infer-links')).toBeChecked();
      await startJob(user);
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined, true);
    });

    it('buildTree: чекбокс логического дерева выключен по умолчанию и не меняет форму вызова', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      const checkbox = screen.getByTestId('ai-import-build-tree');
      expect(checkbox).not.toBeChecked();
      // Подсказка объясняет, что группирующие узлы создаст модель-PO.
      expect(
        screen.getByText('Собрать логическое дерево требований (навык AI Product Owner)'),
      ).toBeInTheDocument();
      await startJob(user);
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined);
    });

    it('buildTree: включённый чекбокс отправляет buildTree=true пятым аргументом', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await user.click(screen.getByTestId('ai-import-build-tree'));
      expect(screen.getByTestId('ai-import-build-tree')).toBeChecked();
      await startJob(user);
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined, false, true);
    });

    it('running relate: shows the step as executing; «Этап:» switches to the relate step (Ф6)', async () => {
      getJob.mockResolvedValue({
        ...RUNNING_JOB,
        stage: 'populate',
        progress: 90,
        relate: { status: 'running', created: 0 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      const status = await screen.findByTestId('ai-import-relate-status');
      expect(status).toHaveTextContent('Проставление связей ФТ↔НФТ: выполняется…');
      // Ф6: while the relate AI call runs, the stage line names the actual step
      // instead of the formal `populate` stage.
      expect(screen.getByTestId('ai-import-stage')).toHaveTextContent(
        'Этап: Проставление связей ФТ↔НФТ',
      );
    });

    it('relate finished: «Этап:» returns to the regular stage label (Ф6, negative)', async () => {
      getJob.mockResolvedValue({
        ...SUCCEEDED_JOB,
        relate: { status: 'done', created: 4 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      expect(screen.getByTestId('ai-import-stage')).toHaveTextContent('Этап: Готово');
    });

    it('done relate: «создано связей: N» next to the success summary', async () => {
      getJob.mockResolvedValue({
        ...SUCCEEDED_JOB,
        relate: { status: 'done', created: 4 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      expect(screen.getByTestId('ai-import-relate-status')).toHaveTextContent(
        'Проставление связей ФТ↔НФТ: создано связей: 4',
      );
    });

    it('done relate: semantic НФТ↔ФТ counter sums extraction + relate step', async () => {
      // result.relatesLinks (2, from extraction) + relate.created (4) = 6.
      getJob.mockResolvedValue({
        ...SUCCEEDED_JOB,
        relate: { status: 'done', created: 4 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      // Tree links (CHILD_OF) stay separate; the semantic total is combined.
      expect(screen.getByTestId('ai-import-tree-links')).toHaveTextContent('9');
      expect(screen.getByTestId('ai-import-relates-links')).toHaveTextContent('6');
    });

    it('partial relate: «создано N, часть не создана»', async () => {
      getJob.mockResolvedValue({
        ...SUCCEEDED_JOB,
        relate: { status: 'partial', created: 3 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      expect(screen.getByTestId('ai-import-relate-status')).toHaveTextContent(
        'Проставление связей ФТ↔НФТ: создано 3, часть не создана',
      );
    });

    it('skipped relate: the step is reported as skipped while the import succeeds', async () => {
      getJob.mockResolvedValue({
        ...SUCCEEDED_JOB,
        relate: { status: 'skipped', created: 0 },
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      // The import itself is successful — the success summary is still there.
      expect(await screen.findByTestId('ai-import-success')).toHaveTextContent('Анализ завершён');
      expect(screen.getByTestId('ai-import-relate-status')).toHaveTextContent(
        'Проставление связей ФТ↔НФТ: шаг пропущен из-за ошибки AI',
      );
    });

    it('without the relate field there is no step block (pre-B2 view)', async () => {
      getJob.mockResolvedValue(SUCCEEDED_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      expect(screen.queryByTestId('ai-import-relate-status')).not.toBeInTheDocument();
    });
  });

  // ── Task 12 · F-2.4 (PO-T2): job lost after a server restart ───────────────
  describe('PO-T2: lost job (GET /api/ai-import/:jobId → 404)', () => {
    const notFound = () => new ApiError(404, { code: 'NOT_FOUND', message: 'Задание не найдено' });

    it('shows the lost-job error with «Повторить анализ» instead of an eternal progress', async () => {
      getJob.mockRejectedValue(notFound());
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      const error = await screen.findByTestId('ai-import-error');
      expect(error).toHaveTextContent('Задание потеряно');
      // Ф9: cause-first wording (restart or expired job) + a clear next step.
      expect(error).toHaveTextContent(
        'Статус задания недоступен (возможно, сервер был перезапущен или задание устарело). ' +
          'Запустите анализ заново.',
      );
      // Failed footer: retry is offered, the running-only stop button is gone.
      expect(screen.getByTestId('ai-import-retry')).toBeInTheDocument();
      expect(screen.queryByTestId('ai-import-stop')).not.toBeInTheDocument();

      // «Повторить анализ» returns to setup with the archive kept.
      await user.click(screen.getByTestId('ai-import-retry'));
      expect(await screen.findByTestId('ai-import-file-name')).toHaveTextContent('docs-portal.zip');
      expect(screen.getByTestId('ai-import-start')).not.toBeDisabled();
    });

    it('stops polling once the job request fails (no endless refetch loop)', async () => {
      getJob.mockRejectedValue(notFound());
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);
      await screen.findByTestId('ai-import-error');

      const callsAtError = getJob.mock.calls.length;
      // Poll cadence is ~800 ms; wait well past it and make sure no new call fired.
      await new Promise((r) => setTimeout(r, 1200));
      expect(getJob.mock.calls.length).toBe(callsAtError);
    });

    it('a job that was visibly running and then vanished flips to the lost-job error', async () => {
      getJob.mockResolvedValueOnce(RUNNING_JOB).mockRejectedValue(notFound());
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      // First poll: normal running view.
      expect(screen.getByTestId('ai-import-progress-pct')).toHaveTextContent('42%');
      // Next poll (~800 ms) hits the 404 → error state, not a frozen progress.
      const error = await screen.findByTestId('ai-import-error', {}, { timeout: 3000 });
      expect(error).toHaveTextContent('Задание потеряно');
      expect(screen.getByTestId('ai-import-retry')).toBeInTheDocument();
      // Closing no longer demands the «Прекратить автоматизацию?» confirmation.
      await user.click(screen.getByTestId('ai-import-error-close'));
      expect(screen.queryByTestId('ai-import-confirm')).not.toBeInTheDocument();
    });
  });

  // ── todo_16 Ф7: partial-result summary after a manual stop ─────────────────

  describe('Ф7: cancelled summary', () => {
    it('cancelled with a result: shows what was created before the stop', async () => {
      getJob.mockResolvedValue(CANCELLED_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      const summary = await screen.findByTestId('ai-import-cancelled-summary');
      expect(summary).toHaveTextContent('Остановлено');
      expect(summary).toHaveTextContent('Анализ прерван на этапе «Извлечение требований»');
      expect(summary).toHaveTextContent('Успели создать: 2 ФТ, 0 НФТ и 0 связей');
      expect(summary).toHaveTextContent('они уже сохранены в проекте');
      expect(summary).toHaveTextContent(
        'Повторный анализ пропустит уже созданные требования — дубликаты не появятся.',
      );
      // The «Остановлено» badge on the file card is still there.
      expect(screen.getByTestId('ai-import-cancelled')).toHaveTextContent('Остановлено');
    });

    it('cancelled without a result: no summary panel', async () => {
      getJob.mockResolvedValue({
        ...CANCELLED_JOB,
        result: undefined,
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-cancelled');
      expect(screen.queryByTestId('ai-import-cancelled-summary')).not.toBeInTheDocument();
    });
  });

  // ── todo_16 Ф8: warn/error counter next to the log ─────────────────────────

  describe('Ф8: warnings badge', () => {
    it('counts warn and error log lines: «Предупреждений: N»', async () => {
      getJob.mockResolvedValue({
        ...RUNNING_JOB,
        log: [
          ...RUNNING_JOB.log, // 1 info + 1 warn
          { ts: '2026-07-04T12:01:30.000Z', level: 'error', message: 'batch 2 failed' },
        ],
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      expect(await screen.findByTestId('ai-import-warn-count')).toHaveTextContent(
        'Предупреждений: 2',
      );
    });

    it('stays visible after the job finishes', async () => {
      getJob.mockResolvedValue(SUCCEEDED_JOB); // log keeps 1 warn line
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      await screen.findByTestId('ai-import-success');
      expect(screen.getByTestId('ai-import-warn-count')).toHaveTextContent('Предупреждений: 1');
    });

    it('zero warnings: no badge at all', async () => {
      getJob.mockResolvedValue({
        ...RUNNING_JOB,
        log: [RUNNING_JOB.log[0]], // the single info line only
      } satisfies AiImportJobView);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await startJob(user);

      expect(screen.getByTestId('ai-import-log')).toHaveTextContent('Архив распакован');
      expect(screen.queryByTestId('ai-import-warn-count')).not.toBeInTheDocument();
    });
  });

  // ── todo_16 Ф10 → todo_20 PO №1: client-side archive size limit (200 МБ) ───

  describe('Ф10: file size check on pick', () => {
    function makeBigFile(): File {
      const f = new File(['x'], 'huge-docs.zip', { type: 'application/zip' });
      // A real 200 МБ payload would slow the test down — fake the size only.
      Object.defineProperty(f, 'size', { value: 200 * 1024 * 1024 + 1 });
      return f;
    }

    it('oversized archive: inline error, file not accepted, start not called', async () => {
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await user.upload(screen.getByTestId('ai-import-file'), makeBigFile());

      expect(await screen.findByTestId('ai-import-start-error')).toHaveTextContent(
        'Файл больше 200 МБ — уменьшите архив документации.',
      );
      // The file was rejected: no file card, start stays disabled, no API call.
      expect(screen.queryByTestId('ai-import-file-name')).not.toBeInTheDocument();
      expect(screen.getByTestId('ai-import-start')).toBeDisabled();
      await user.click(screen.getByTestId('ai-import-start'));
      expect(startImport).not.toHaveBeenCalled();
    });

    it('a normal archive after the oversized one clears the error and starts fine', async () => {
      getJob.mockResolvedValue(RUNNING_JOB);
      const user = userEvent.setup();
      renderModal();
      await waitForProjectModel();
      await user.upload(screen.getByTestId('ai-import-file'), makeBigFile());
      await screen.findByTestId('ai-import-start-error');

      await startJob(user); // uploads the regular small archive + starts
      expect(screen.queryByTestId('ai-import-start-error')).not.toBeInTheDocument();
      expect(startImport).toHaveBeenCalledWith('proj-1', archive, undefined);
    });
  });
});
