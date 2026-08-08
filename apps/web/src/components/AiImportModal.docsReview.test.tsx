import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiDocsReview, AiImportJobView } from '@po/core';
import { AiImportModal } from './AiImportModal';
import { renderWithProviders } from '../test/utils';

/*
 * Двухзонная выверка дублей docs-импорта: джоба останавливается на
 * `awaiting-review` с payload `docsReview` — модалка показывает шаг выверки
 * (зона 1 «дубли между собой» → зона 2 «дубли с проектом») и пишет в проект
 * только после подтверждения зоны 2.
 */

const getConfig = vi.fn();
const listModels = vi.fn();
const startImport = vi.fn();
const getJob = vi.fn();
const cancelJob = vi.fn();
const applyDocs = vi.fn();
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
    confirm: vi.fn(),
    resume: vi.fn(),
    applyDocs: (...a: unknown[]) => applyDocs(...a),
    listJobs: (...a: unknown[]) => listJobs(...a),
    logUrl: (jobId: string) => `/api/ai-import/${jobId}/log`,
  },
}));

const CONFIGURED = {
  baseURL: 'https://api.ai.sbt/openai/v1',
  hasApiKey: true,
  model: 'GigaChat-2-Pro',
};

function reviewItem(
  id: string,
  name: string,
  over: Partial<AiDocsReview['items'][number]> = {},
): AiDocsReview['items'][number] {
  return {
    id,
    record: {
      type: 'FUNCTION',
      name,
      description: `Описание «${name}».`,
      source: 'doc.md § 1',
    },
    parentName: null,
    ...over,
  };
}

const ZONE1_REVIEW: AiDocsReview = {
  phase: 'self',
  items: [
    reviewItem('d1', 'Быстрый фильтр по статусу', { groupId: 'g1' }),
    reviewItem('d2', 'Быстрый фильтр по статусам', { groupId: 'g1' }),
    reviewItem('d3', 'Экспорт проекта', { parentName: 'Быстрый фильтр по статусу' }),
  ],
  autoMerged: ['повтор имени'],
  groupCount: 1,
  duplicateCount: 0,
};

const ZONE1_JOB: AiImportJobView = {
  jobId: 'job-r1',
  projectId: 'proj-1',
  status: 'awaiting-review',
  stage: 'aggregate',
  progress: 82,
  log: [{ ts: '2026-08-08T10:00:00.000Z', level: 'info', message: 'Анализ завершён.' }],
  docsReview: ZONE1_REVIEW,
};

const ZONE2_JOB: AiImportJobView = {
  ...ZONE1_JOB,
  progress: 84,
  docsReview: {
    phase: 'existing',
    items: [
      reviewItem('d1', 'Быстрый фильтр по статусу', {
        duplicateOf: 'Быстрый фильтр по статусу',
        duplicateSimilarity: 1,
      }),
      reviewItem('d3', 'Экспорт проекта'),
    ],
    autoMerged: [],
    groupCount: 1,
    duplicateCount: 1,
  },
};

const archive = new File(['dummy'], 'docs.zip', { type: 'application/zip' });

async function openAtReview(job: AiImportJobView): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  getJob.mockResolvedValue(job);
  renderWithProviders(<AiImportModal projectId="proj-1" onClose={vi.fn()} />);
  await user.upload(screen.getByTestId('ai-import-file'), archive);
  await waitFor(() => expect(screen.getByTestId('ai-import-start')).not.toBeDisabled());
  await user.click(screen.getByTestId('ai-import-start'));
  await screen.findByTestId('ai-docs-review-step');
  return user;
}

describe('AiImportModal · двухзонная выверка дублей', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIGURED);
    listModels.mockReset().mockResolvedValue({ models: ['GigaChat-2-Pro'] });
    startImport.mockReset().mockResolvedValue({ jobId: 'job-r1' });
    getJob.mockReset();
    cancelJob.mockReset();
    applyDocs.mockReset();
    listJobs.mockReset().mockResolvedValue({ jobs: [] });
  });

  it('зона 1: таблица с группами дублей, местом в дереве; в группе по умолчанию выбрана одна запись', async () => {
    await openAtReview(ZONE1_JOB);

    // Баннер зоны 1 с числом групп.
    expect(screen.getByTestId('ai-docs-review-banner')).toHaveTextContent('Зона 1');
    expect(screen.getByTestId('ai-docs-review-banner')).toHaveTextContent(
      'групп смысловых дублей: 1',
    );

    // Группа видна бейджами, обе записи пары показаны (полная картина).
    expect(screen.getByTestId('ai-docs-review-group-d1')).toHaveTextContent('группа 1');
    expect(screen.getByTestId('ai-docs-review-group-d2')).toHaveTextContent('группа 1');

    // Предлагаемое место в дереве.
    expect(screen.getByTestId('ai-docs-review-parent-d3')).toHaveTextContent(
      'под «Быстрый фильтр по статусу»',
    );
    expect(screen.getByTestId('ai-docs-review-parent-d1')).toHaveTextContent('корень');

    // Дефолтный выбор: первая запись группы + всё вне групп ⇒ d1 и d3.
    expect(screen.getByTestId('ai-docs-review-check-d1')).toBeChecked();
    expect(screen.getByTestId('ai-docs-review-check-d2')).not.toBeChecked();
    expect(screen.getByTestId('ai-docs-review-check-d3')).toBeChecked();

    // Кнопка ведёт в зону 2 и honest-хинт «ничего не записано».
    expect(screen.getByTestId('ai-docs-review-apply')).toHaveTextContent(
      'Продолжить: дубли с проектом (2)',
    );
    expect(screen.getByTestId('ai-docs-review-hint')).toHaveTextContent(
      'До подтверждения в проект ничего не записано',
    );
  });

  it('апрув зоны 1 шлёт {phase:"self", ids} и открывает зону 2 с дублями против проекта', async () => {
    const user = await openAtReview(ZONE1_JOB);
    applyDocs.mockResolvedValue(ZONE2_JOB);

    await user.click(screen.getByTestId('ai-docs-review-apply'));
    await waitFor(() =>
      expect(applyDocs).toHaveBeenCalledWith('job-r1', { phase: 'self', ids: ['d1', 'd3'] }),
    );

    // Зона 2: дубль с проектом по умолчанию исключён, чистая запись выбрана.
    await screen.findByTestId('ai-docs-review-dup-d1');
    expect(screen.getByTestId('ai-docs-review-banner')).toHaveTextContent('Зона 2');
    expect(screen.getByTestId('ai-docs-review-dup-d1')).toHaveTextContent(
      'дубль: «Быстрый фильтр по статусу»',
    );
    await waitFor(() => expect(screen.getByTestId('ai-docs-review-check-d1')).not.toBeChecked());
    expect(screen.getByTestId('ai-docs-review-check-d3')).toBeChecked();
    expect(screen.getByTestId('ai-docs-review-apply')).toHaveTextContent('Записать в проект (1)');
  });

  it('апрув зоны 2 шлёт {phase:"existing", ids}; пустой выбор — «Завершить без записи»', async () => {
    const user = await openAtReview(ZONE2_JOB);
    applyDocs.mockResolvedValue({ ...ZONE2_JOB, status: 'running', stage: 'populate' });

    // Дефолт: только d3 (d1 — дубль). Снимаем и его — честный «ничего».
    expect(screen.getByTestId('ai-docs-review-apply')).toHaveTextContent('Записать в проект (1)');
    await user.click(screen.getByTestId('ai-docs-review-check-d3'));
    expect(screen.getByTestId('ai-docs-review-apply')).toHaveTextContent('Завершить без записи');

    // Возвращаем и подтверждаем запись.
    await user.click(screen.getByTestId('ai-docs-review-check-d3'));
    await user.click(screen.getByTestId('ai-docs-review-apply'));
    await waitFor(() =>
      expect(applyDocs).toHaveBeenCalledWith('job-r1', { phase: 'existing', ids: ['d3'] }),
    );
  });

  it('«Отменить импорт» на выверке защищён confirm-диалогом и зовёт cancel', async () => {
    const user = await openAtReview(ZONE1_JOB);
    cancelJob.mockResolvedValue({ ...ZONE1_JOB, status: 'cancelled', docsReview: undefined });

    await user.click(screen.getByTestId('ai-docs-review-cancel'));
    const dialog = await screen.findByTestId('ai-docs-review-cancel-confirm');
    expect(dialog).toHaveTextContent('В проект ничего не записано');
    await user.click(screen.getByTestId('ai-docs-review-cancel-confirm-confirm'));
    await waitFor(() => expect(cancelJob).toHaveBeenCalledWith('job-r1'));
  });
});
