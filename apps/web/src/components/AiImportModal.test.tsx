import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiImportJobView } from '@po/core';
import { AiImportModal } from './AiImportModal';
import { renderWithProviders } from '../test/utils';
import { queryKeys } from '../api/hooks';

const getConfig = vi.fn();
const listModels = vi.fn();
const startImport = vi.fn();
const getJob = vi.fn();
const cancelJob = vi.fn();

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
  result: { createdFunctions: 18, createdNfrs: 6, skippedExisting: 3, links: 9 },
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
  result: { createdFunctions: 2, createdNfrs: 0, skippedExisting: 0, links: 0 },
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
  });

  /** The disabled placeholder select is swapped for the live one once the AI
   *  config arrives — always re-query instead of holding on to the element. */
  async function waitForProjectModel(): Promise<HTMLElement> {
    await waitFor(() =>
      expect(screen.getByTestId('ai-import-model-select')).toHaveValue('GigaChat-2-Pro'),
    );
    return screen.getByTestId('ai-import-model-select');
  }

  it('without a file: start disabled with tooltip, model defaults to the project model', async () => {
    renderModal();
    await waitForProjectModel();
    const start = screen.getByTestId('ai-import-start');
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Загрузите архив документации');
    expect(screen.getByTestId('ai-import-drop')).toBeInTheDocument();
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

  it('running: renders stage, progress % and the log; stop cancels the job', async () => {
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

    await user.click(screen.getByTestId('ai-import-stop'));
    expect(cancelJob).toHaveBeenCalledWith('job-1');
    // The cancelled view keeps the log and offers a fresh start.
    expect(await screen.findByTestId('ai-import-cancelled')).toHaveTextContent('Остановлено');
    expect(screen.getByTestId('ai-import-log')).toBeInTheDocument();
    expect(screen.getByTestId('ai-import-start')).not.toBeDisabled();
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

  it('succeeded: shows totals, invalidates requirements, «Закрыть и перейти к проекту» closes', async () => {
    getJob.mockResolvedValue(SUCCEEDED_JOB);
    const user = userEvent.setup();
    const { onClose, queryClient } = renderModal();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByTestId('ai-import-model-select');
    await startJob(user);

    const success = await screen.findByTestId('ai-import-success');
    expect(success).toHaveTextContent('Подгрузка завершена');
    expect(success).toHaveTextContent('18 ФТ');
    expect(success).toHaveTextContent('6 НФТ');
    expect(success).toHaveTextContent('связей: 9');
    expect(success).toHaveTextContent('Пропущено как существующие: 3');

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.requirements('proj-1') }),
    );

    await user.click(screen.getByTestId('ai-import-done'));
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
});
