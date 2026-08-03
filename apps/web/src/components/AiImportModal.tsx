import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleStop, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  AiImportJobSummary,
  AiImportJobView,
  AiImportRelateView,
  AiImportSourceClass,
  AiImportStage,
} from '@po/core';
import { AI_IMPORT_MAX_ARCHIVE_BYTES, AI_IMPORT_SOURCE_CLASSES } from '@po/core';
import {
  useAiConfig,
  useAiImportJob,
  useAiImportJobs,
  useAiModelsRefresh,
  useCancelAiImport,
  useConfirmAiImport,
  useResumeAiImport,
  useStartAiImport,
} from '../api/hooks';
import { aiImportApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Modal } from './Modal';
import { BusyButton } from './BusyButton';
import { ConfirmDialog } from './ConfirmDialog';
import { ModelListNotice, ModelRefreshButton } from './ModelRefresh';
import { TaxonomyErrorCard, TaxonomyErrorDetails } from './AiImportErrorBlocks';
import { AiImportHistoryList, formatDateTime } from './AiImportHistoryList';
import { AI_IMPORT_LOG_BG, AI_IMPORT_LOG_LEVEL_COLOR, AI_IMPORT_LOG_TEXT } from '../lib/logColors';
import { plural } from '../lib/plural';

/**
 * Task 11: «AI подгрузка ФТ и НФТ из документации» — upload a zip/tar.gz
 * archive, pick a model (project model by default, same pattern as the chat
 * widget) and run the server-side extraction job. The modal polls the job
 * (~800 ms), renders stage + progress + live log, and guards closing while
 * the job is running with a ConfirmDialog (spec §1.2, mockup states 1–7).
 */

/** Russian labels of the job stages (mockup state 4/6/7). */
export const AI_IMPORT_STAGE_LABELS: Record<AiImportStage, string> = {
  unpack: 'Распаковка архива',
  analyze: 'Извлечение требований',
  structure: 'Построение древовидной структуры ФТ/НФТ',
  aggregate: 'Агрегация',
  populate: 'Наполнение проекта',
  done: 'Готово',
};

const MODEL_HINT = 'Задайте API-ключ на экране AI (меню проекта → AI), затем выберите модель.';

/**
 * §2.18.4 + todo_18: human wording of the opt-in AI relate step. The import
 * always builds the ФТ tree and the НФТ tree (CHILD_OF); this checkbox adds the
 * third kind of analysis — meaningful cross-links between НФТ and ФТ
 * (RELATES_TO). No internal terms.
 */
const INFER_LINKS_LABEL = 'Находить смысловые связи между НФТ и ФТ (AI)';
const INFER_LINKS_HINT =
  'Деревья ФТ и НФТ строятся всегда; эта опция дополнительно связывает НФТ ' +
  'с ФТ по смыслу. Возможны неточные связи; новые требования не добавляются.';

/** Name of the optional relate step shown in the progress/result view. */
const RELATE_STEP_LABEL = 'Проставление связей ФТ↔НФТ';

/**
 * Human-readable outcome of the relate step (todo_16 B2). `skipped` means the
 * AI call failed/timed out — the import itself still succeeded.
 */
export function relateStatusText(relate: AiImportRelateView): string {
  switch (relate.status) {
    case 'running':
      return 'выполняется…';
    case 'done':
      return `создано связей: ${relate.created}`;
    case 'partial':
      return `создано ${relate.created}, часть не создана`;
    case 'skipped':
      return 'шаг пропущен из-за ошибки AI';
  }
}

/** Ф9 (todo_16): a 404 on the job poll — restart-safe, human-readable text. */
const JOB_LOST_MESSAGE =
  'Статус задания недоступен (возможно, сервер был перезапущен или задание устарело). ' +
  'Запустите анализ заново.';

/** todo_20 PO №1: the 200 МБ limit, derived from the contract constant. */
const MAX_ARCHIVE_MB = Math.floor(AI_IMPORT_MAX_ARCHIVE_BYTES / (1024 * 1024));

/** Ф10 (todo_16 → todo_20): client-side mirror of the server archive size limit. */
const FILE_TOO_BIG_MESSAGE = `Файл больше ${MAX_ARCHIVE_MB} МБ — уменьшите архив документации.`;

/** todo_20 П1: Russian labels of the content source classes (mockup 01). */
export const AI_IMPORT_SOURCE_CLASS_LABELS: Record<AiImportSourceClass, string> = {
  'release-notes': 'Release notes',
  'user-guide': 'Руководства',
  'admin-guide': 'Администрирование',
  security: 'Безопасность',
  'api-spec': 'API-спецификации',
  config: 'Конфигурация',
  other: 'Прочее',
};

/** todo_20 PO №4 → todo_22: labels moved to the shared history list component. */
export { AI_IMPORT_STATUS_LABELS } from './AiImportHistoryList';

/** 1_400_000 → «1,4 млн», 96_000 → «96 тыс.», 950 → «950» (ru, mockup 01/03). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} млн`;
  if (n >= 10_000) return `${Math.round(n / 1000)} тыс.`;
  return String(n);
}

/** 9600 → «≈ 2 ч 40 мин», 320 → «≈ 6 мин», 40 → «≈ 40 с» (PO decision №6). */
export function formatEta(seconds: number): string {
  const s = Math.round(seconds);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `≈ ${h} ч ${m} мин` : `≈ ${h} ч`;
  }
  if (s >= 60) return `≈ ${Math.round(s / 60)} мин`;
  return `≈ ${s} с`;
}

const CONFIRM_MESSAGE =
  'Анализ документации ещё выполняется. Если закрыть окно, процесс будет остановлен. ' +
  'Уже созданные требования останутся в проекте.';

/** 4200000 → «4,2 МБ» (ru decimal comma, as in the mockup). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

/** ISO timestamp → local HH:MM:SS for the log gutter. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('ru-RU', { hour12: false });
}

interface AiImportModalProps {
  projectId: string;
  onClose: () => void;
}

/**
 * Local view phase. todo_20 adds `estimate` (job paused on the confirmation
 * gate, status `awaiting-confirmation`) and `interrupted` (unfinished job
 * discovered after a server restart).
 */
type Phase =
  'setup' | 'estimate' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export function AiImportModal({ projectId, onClose }: AiImportModalProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  // B2: optional AI relate step (ФТ↔НФТ links), off by default.
  const [inferLinks, setInferLinks] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // §2.18.1: «Остановить» is guarded by its own mini-confirm (not instant).
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // todo_20 T-214: «Повторить с меньшими фрагментами» — inline how-to hint.
  const [smallerHintOpen, setSmallerHintOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const configQuery = useAiConfig(projectId);
  const config = configQuery.data;
  const configured = Boolean(config?.hasApiKey);

  const startMut = useStartAiImport(projectId);
  const jobQuery = useAiImportJob(projectId, jobId);
  const cancelMut = useCancelAiImport();
  const confirmMut = useConfirmAiImport();
  const resumeMut = useResumeAiImport(projectId);
  // todo_20 PO №4: full run history of the project (newest first).
  const historyQuery = useAiImportJobs(projectId);
  const historyJobs: AiImportJobSummary[] = historyQuery.data?.jobs ?? [];
  const job: AiImportJobView | undefined = jobId ? jobQuery.data : undefined;

  // Modal-selected model wins over the per-project one (spec §3.5).
  const selectedModel = modelOverride ?? config?.model ?? '';
  const modelReady = configured && selectedModel.length > 0;

  // A3: same rule as the chat widget — models are requested only once a key
  // exists; the refresh button refetches and reconciles a vanished selection
  // (project model / first one) with an inline notice.
  const modelsRefresh = useAiModelsRefresh({
    enabled: configured,
    selectedModel,
    fallbackModel: config?.model,
    onModelReset: setModelOverride,
  });

  // Loaded models + the currently selected one, so the value is never lost.
  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsRefresh.models);
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [modelsRefresh.models, selectedModel]);

  // PO-T2: the job vanished server-side (404 after a restart — jobs are
  // in-memory). Treat it as a failure with a retry, not an eternal progress.
  const jobLost = Boolean(jobId) && jobQuery.isError;
  const phase: Phase = !jobId
    ? 'setup'
    : jobLost
      ? 'failed'
      : // todo_22: `awaiting-review` is a backlog-only pause — docs jobs never
        // reach it; the neutral running view keeps the exhaustive mapping honest.
        !job || job.status === 'running' || job.status === 'awaiting-review'
        ? 'running'
        : job.status === 'awaiting-confirmation'
          ? 'estimate'
          : job.status;
  // Start already sent (or job view not loaded yet) counts as running for the
  // close guard — the job may well be alive on the server.
  const running = phase === 'running' || startMut.isPending;

  // Autoscroll the log to the latest line (mockup state 4).
  const logLength = job?.log.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLength]);

  const pickFile = (f: File | null | undefined): void => {
    if (!f) return;
    // Ф10: reject oversized archives client-side, before any upload — the
    // server enforces the same AI_IMPORT_MAX_ARCHIVE_BYTES limit (@po/core).
    if (f.size > AI_IMPORT_MAX_ARCHIVE_BYTES) {
      setStartError(FILE_TOO_BIG_MESSAGE);
      return;
    }
    setFile(f);
    setStartError(null);
  };

  const doStart = (): void => {
    if (!file || !modelReady || startMut.isPending) return;
    setStartError(null);
    startMut.mutate(
      { file, model: modelOverride ?? undefined, inferLinks },
      {
        onSuccess: (res) => setJobId(res.jobId),
        onError: (err) => setStartError(errorMessage(err)),
      },
    );
  };

  const stopJob = (): void => {
    if (jobId) cancelMut.mutate(jobId);
  };

  /** X / overlay / Escape: confirm while running, close silently otherwise. */
  const requestClose = (): void => {
    // Escape is already being handled by an open ConfirmDialog.
    if (confirmOpen || stopConfirmOpen) return;
    if (phase === 'estimate') {
      // Estimate gate: no LLM calls have started — cancel silently and close.
      stopJob();
      onClose();
      return;
    }
    if (running) setConfirmOpen(true);
    else onClose();
  };

  /** «Повторить анализ» after a failure: back to the file-selected state. */
  const retry = (): void => {
    setJobId(null);
    setSmallerHintOpen(false);
    startMut.reset();
    resumeMut.reset();
  };

  /** todo_20 T-212: «Продолжить» — resume the SAME job from its checkpoint. */
  const resumeJob = (id?: string): void => {
    const target = id ?? jobId;
    if (!target || resumeMut.isPending) return;
    setSmallerHintOpen(false);
    resumeMut.mutate(target, {
      // History rows resume jobs the modal is not looking at yet.
      onSuccess: ({ jobId: resumedId }) => setJobId(resumedId),
    });
  };

  /** todo_20 PO №4: open a past run (report / log / progress) in this modal. */
  const openHistoryJob = (id: string): void => {
    setSmallerHintOpen(false);
    resumeMut.reset();
    setJobId(id);
  };

  const startDisabled = !file || !modelReady || startMut.isPending;
  const startTitle = !file
    ? 'Загрузите архив документации'
    : !modelReady
      ? 'Настройте AI Hub'
      : undefined;
  /* §3 (pattern 1): the disabled reason is also readable text left of the button. */
  const setupHint = !file
    ? 'Загрузите архив документации'
    : !modelReady
      ? 'Настройте AI Hub'
      : 'Файл выбран — можно начинать';

  const startButton = (
    <BusyButton
      className="btn btn-primary text-sm"
      busy={startMut.isPending}
      busyLabel="Запускаем…"
      data-testid="ai-import-start"
      disabled={startDisabled}
      title={startTitle}
      onClick={doStart}
    >
      Начать анализ
    </BusyButton>
  );

  const result = job?.result;
  const estimate = job?.estimate;
  const inventory = job?.inventory;
  const usage = job?.usage;
  const report = job?.report;
  // todo_20 П6: taxonomy error (code present) → new action-ranked fail view;
  // otherwise the pre-todo_20 message+hint rendering stays byte-identical.
  const jobError = jobLost ? undefined : job?.error;
  const taxonomyError = Boolean(jobError?.code);
  const resumable = Boolean(jobError?.resumable) && !jobLost;
  const logUrl = jobId && !jobLost ? aiImportApi.logUrl(jobId) : null;

  const footer =
    phase === 'setup' ? (
      <>
        <p className="hint mr-auto self-center" data-testid="ai-import-footer-hint">
          {setupHint}
        </p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-cancel"
          onClick={onClose}
        >
          Отмена
        </button>
        {startButton}
      </>
    ) : phase === 'estimate' ? (
      /* todo_20 П2: the estimate gate — LLM calls have not started yet. */
      <>
        <p className="hint mr-auto self-center">AI-вызовы ещё не начались — отмена бесплатна</p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-estimate-cancel"
          disabled={cancelMut.isPending}
          onClick={stopJob}
        >
          Отмена
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={confirmMut.isPending}
          busyLabel="Запускаем…"
          data-testid="ai-import-confirm-start"
          onClick={() => {
            if (jobId) confirmMut.mutate({ jobId });
          }}
        >
          {estimate?.overThreshold ? 'Запустить всё равно' : 'Запустить импорт'}
        </BusyButton>
      </>
    ) : phase === 'interrupted' ? (
      /* todo_20 П5.2: discovered after a server restart — resume from checkpoint. */
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-error-close"
          onClick={onClose}
        >
          Закрыть
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={resumeMut.isPending}
          busyLabel="Продолжаем…"
          data-testid="ai-import-resume"
          onClick={() => resumeJob()}
        >
          Продолжить
        </BusyButton>
      </>
    ) : phase === 'running' ? (
      <>
        <p className="hint mr-auto self-center">
          Уже созданные требования сохраняются на диск сразу
        </p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          style={{ color: 'var(--color-danger-fg)' }}
          data-testid="ai-import-stop"
          disabled={cancelMut.isPending || !jobId}
          onClick={() => setStopConfirmOpen(true)}
        >
          <CircleStop className="icon-sm" aria-hidden="true" />
          Остановить
        </button>
      </>
    ) : phase === 'succeeded' ? (
      /* §2.18.2: plain «Готово» — no promised navigation. */
      <button
        type="button"
        className="btn btn-primary text-sm"
        data-testid="ai-import-done"
        onClick={onClose}
      >
        Готово
      </button>
    ) : phase === 'failed' && taxonomyError ? (
      /* todo_20 П6.3, DESIGN ranking: partial result → smaller fragments →
         «Продолжить» (primary, when resumable). */
      <>
        {result ? (
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="ai-import-open-partial"
            onClick={onClose}
          >
            Открыть частичный результат
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-smaller-chunks"
          aria-expanded={smallerHintOpen}
          onClick={() => setSmallerHintOpen((v) => !v)}
        >
          Повторить с меньшими фрагментами
        </button>
        {resumable ? (
          <BusyButton
            className="btn btn-primary text-sm"
            busy={resumeMut.isPending}
            busyLabel="Продолжаем…"
            data-testid="ai-import-resume"
            onClick={() => resumeJob()}
          >
            Продолжить
          </BusyButton>
        ) : file ? (
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="ai-import-retry"
            onClick={retry}
          >
            Повторить анализ
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="ai-import-error-close"
            onClick={onClose}
          >
            Закрыть
          </button>
        )}
      </>
    ) : phase === 'failed' ? (
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-error-close"
          onClick={onClose}
        >
          Закрыть
        </button>
        <button
          type="button"
          className="btn btn-primary text-sm"
          data-testid="ai-import-retry"
          onClick={retry}
        >
          Повторить анализ
        </button>
      </>
    ) : (
      /* cancelled: honest panel + a retry that is available right away. */
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-retry"
          onClick={retry}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Повторить анализ
        </button>
        <button
          type="button"
          className="btn btn-primary text-sm"
          data-testid="ai-import-done"
          onClick={onClose}
        >
          Готово
        </button>
      </>
    );

  const progress = job?.progress ?? 0;
  const stageLabel = AI_IMPORT_STAGE_LABELS[job?.stage ?? 'unpack'];
  // B2: present only when the import was started with inferLinks (absent → no block).
  const relate = job?.relate;
  // todo_18: total meaningful НФТ↔ФТ links (RELATES_TO) = links found during
  // extraction (`result.relatesLinks`) + links added by the optional relate step
  // (`relate.created`, non-zero only when the step actually ran).
  const relatesTotal = (result?.relatesLinks ?? 0) + (relate?.created ?? 0);
  // Ф6: while the AI relate call runs the job formally sits on `populate` —
  // show the relate step in the «Этап:» line so the user sees what is going on.
  const currentStepLabel = relate?.status === 'running' ? RELATE_STEP_LABEL : stageLabel;
  // Ф8: warnings counter next to the log (warn + error lines), hidden at 0.
  const warnCount = (job?.log ?? []).filter((e) => e.level !== 'info').length;
  const relateColor =
    relate?.status === 'done'
      ? 'var(--color-success-fg)'
      : relate?.status === 'running'
        ? 'var(--color-text-3)'
        : 'var(--color-warning-fg)'; // partial / skipped

  const fileCard = file ? (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="min-w-0 text-sm" data-testid="ai-import-file-name">
        <span className="font-bold">{file.name}</span>{' '}
        <span style={{ color: 'var(--color-text-3)' }}>· {formatFileSize(file.size)}</span>
      </div>
      {phase === 'setup' ? (
        <button
          type="button"
          className="shrink-0 text-sm font-semibold"
          style={{ color: 'var(--color-primary)' }}
          data-testid="ai-import-replace"
          onClick={() => fileInputRef.current?.click()}
        >
          Заменить
        </button>
      ) : phase === 'running' ? (
        <span
          className="badge shrink-0"
          style={{ background: 'var(--color-primary)', color: '#fff' }}
        >
          Анализ…
        </span>
      ) : phase === 'cancelled' ? (
        <span
          className="badge shrink-0"
          style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }}
          data-testid="ai-import-cancelled"
        >
          Остановлено
        </span>
      ) : null}
    </div>
  ) : null;

  return (
    <Modal
      title="AI-импорт документации"
      testid="ai-import"
      widthClass="max-w-[640px]"
      /* task24: ~70% of the viewport on desktop — the estimate inventory,
         progress feed, quality report and history need the room. Mobile keeps
         the old near-full-width behaviour (widthClass applies below md). */
      size="large"
      onClose={requestClose}
      onOverlayClick={requestClose}
      footer={footer}
    >
      {/* Hidden but always-mounted input: drop-zone «выберите файл» and the
          «Заменить» button both delegate to it. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.tar.gz,.tgz"
        className="sr-only"
        aria-label="Архив документации (zip или tar.gz)"
        data-testid="ai-import-file"
        onChange={(e) => {
          pickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {phase === 'setup' ? (
        <>
          {file ? (
            fileCard
          ) : (
            <div
              className="rounded-[10px] border-2 border-dashed px-4 py-5 text-center text-sm"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-3)' }}
              data-testid="ai-import-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files?.[0]);
              }}
            >
              Перетащите архив с документацией сюда или{' '}
              <button
                type="button"
                className="font-semibold"
                style={{ color: 'var(--color-primary)' }}
                data-testid="ai-import-browse"
                onClick={() => fileInputRef.current?.click()}
              >
                выберите файл
              </button>
              <br />
              <span className="text-xs">
                .zip или .tar.gz, до {MAX_ARCHIVE_MB} МБ (.md/.txt внутри)
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label
              htmlFor="ai-import-model"
              className="shrink-0 text-sm"
              style={{ color: 'var(--color-text-3)' }}
            >
              Модель:
            </label>
            {configured ? (
              <>
                <select
                  id="ai-import-model"
                  className="input min-w-0 flex-1 cursor-pointer py-1.5 text-sm"
                  title="Модель для анализа документации"
                  data-testid="ai-import-model-select"
                  value={selectedModel}
                  onChange={(e) => {
                    modelsRefresh.clearNotice();
                    setModelOverride(e.target.value);
                  }}
                >
                  {selectedModel.length === 0 ? (
                    <option value="">— выберите модель —</option>
                  ) : null}
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <ModelRefreshButton
                  testid="ai-models-refresh-import"
                  className="btn btn-secondary px-2.5 py-1.5"
                  refreshing={modelsRefresh.isFetching}
                  onClick={() => void modelsRefresh.refresh()}
                />
              </>
            ) : (
              <div className="min-w-0 flex-1" title={MODEL_HINT} data-testid="ai-import-model-hint">
                <select
                  id="ai-import-model"
                  className="input w-full cursor-not-allowed py-1.5 text-sm opacity-50"
                  disabled
                  data-testid="ai-import-model-select"
                >
                  <option>Модель не настроена</option>
                </select>
              </div>
            )}
          </div>

          {/* A3: inline notice — selection reset after refresh / refresh failure. */}
          <ModelListNotice testid="ai-models-notice-import" notice={modelsRefresh.notice} />

          {/* B2 + §2.18.4: opt-in AI relate step, human wording + honest hint. */}
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
              data-testid="ai-import-infer-links"
              checked={inferLinks}
              onChange={(e) => setInferLinks(e.target.checked)}
            />
            <span>
              {INFER_LINKS_LABEL}
              <span className="hint mt-0.5 block">{INFER_LINKS_HINT}</span>
            </span>
          </label>

          {startError ? (
            <div
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              role="alert"
              data-testid="ai-import-start-error"
            >
              {startError}
            </div>
          ) : null}

          {/* todo_20 П5.2 (mockup 06): unfinished run found after a restart. */}
          {(() => {
            const interrupted = historyJobs.find((j) => j.status === 'interrupted');
            if (!interrupted) return null;
            return (
              <div
                className="flex items-start justify-between gap-3 rounded-lg p-3"
                style={{ background: 'var(--color-warning-bg)' }}
                data-testid="ai-import-interrupted-banner"
              >
                <div className="text-sm" style={{ color: 'var(--color-warning-fg)' }}>
                  <b>Найден незавершённый AI-импорт</b> — прерван перезапуском сервера{' '}
                  {formatDateTime(interrupted.startedAt)}. Всё созданное сохранено; продолжение
                  начнётся с места остановки.
                </div>
                <BusyButton
                  className="btn btn-primary shrink-0 text-sm"
                  busy={resumeMut.isPending}
                  busyLabel="Продолжаем…"
                  data-testid="ai-import-interrupted-resume"
                  onClick={() => resumeJob(interrupted.jobId)}
                >
                  Продолжить
                </BusyButton>
              </div>
            );
          })()}

          {/* todo_20 PO №4: full run history of the project (newest first). */}
          <AiImportHistoryList
            testidPrefix="ai-import"
            jobs={historyJobs}
            resumePending={resumeMut.isPending}
            onResume={resumeJob}
            onOpen={openHistoryJob}
          />
        </>
      ) : (
        <>
          {fileCard}

          {/* todo_20 П1+П2 (mockups 01/02): the estimate step before any LLM call. */}
          {phase === 'estimate' ? (
            <div className="space-y-4" data-testid="ai-import-estimate-step">
              <div
                className="flex items-center gap-2 text-xs"
                style={{ color: 'var(--color-text-3)' }}
                aria-hidden="true"
              >
                <span
                  className="rounded-full px-2 py-0.5 font-medium"
                  style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                >
                  1. Смета
                </span>
                <span>→</span>
                <span>2. Извлечение</span>
                <span>→</span>
                <span>3. Итог</span>
              </div>

              {inventory ? (
                <section data-testid="ai-import-inventory">
                  <h4 className="mb-2 text-sm font-semibold">
                    Опись архива — {inventory.totalFiles}{' '}
                    {plural(inventory.totalFiles, 'файл', 'файла', 'файлов')}
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                    {AI_IMPORT_SOURCE_CLASSES.filter((c) => (inventory.processed[c] ?? 0) > 0).map(
                      (c) => (
                        <div
                          key={c}
                          className="rounded-lg border px-3 py-2"
                          style={{
                            borderColor: 'var(--color-border)',
                            background: 'var(--color-surface-2)',
                          }}
                          data-testid={`ai-import-inventory-${c}`}
                        >
                          <div className="font-semibold">{inventory.processed[c]}</div>
                          <div style={{ color: 'var(--color-text-2)' }}>
                            {AI_IMPORT_SOURCE_CLASS_LABELS[c]}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                  <p className="hint mt-2">
                    Классы определены по содержимому файлов; порядок обработки — по ценности
                    источника (release notes первыми).
                  </p>
                </section>
              ) : null}

              {inventory && inventory.excluded.length > 0 ? (
                <details
                  className="rounded-lg border"
                  style={{ borderColor: 'var(--color-border)' }}
                  data-testid="ai-import-excluded"
                >
                  <summary
                    className="cursor-pointer select-none px-4 py-2.5 text-sm"
                    style={{ color: 'var(--color-text-2)' }}
                  >
                    Исключено из обработки —{' '}
                    {inventory.excluded.reduce((acc, e) => acc + e.count, 0)}{' '}
                    {plural(
                      inventory.excluded.reduce((acc, e) => acc + e.count, 0),
                      'файл',
                      'файла',
                      'файлов',
                    )}
                  </summary>
                  <ul
                    className="space-y-1 px-4 pb-3 text-sm"
                    style={{ color: 'var(--color-text-2)' }}
                  >
                    {inventory.excluded.map((e, i) => (
                      <li key={i} className="flex justify-between gap-4">
                        <span className="min-w-0 break-all">{e.path}</span>
                        <span className="shrink-0" style={{ color: 'var(--color-text-3)' }}>
                          {e.reason} — {e.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {estimate ? (
                <section
                  className="rounded-lg p-4"
                  style={{
                    background: estimate.overThreshold
                      ? 'var(--color-warning-bg)'
                      : 'var(--color-info-bg)',
                    color: estimate.overThreshold
                      ? 'var(--color-warning-fg)'
                      : 'var(--color-info-fg)',
                  }}
                  data-testid={
                    estimate.overThreshold ? 'ai-import-estimate-warning' : 'ai-import-estimate'
                  }
                >
                  <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                    {estimate.overThreshold ? (
                      <>
                        <TriangleAlert size={14} aria-hidden="true" />
                        Оценка превышает порог подтверждения
                      </>
                    ) : (
                      'Оценка прогона'
                    )}
                  </h4>
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs opacity-80">Файлов</dt>
                      <dd className="font-semibold">{estimate.files}</dd>
                    </div>
                    <div>
                      <dt className="text-xs opacity-80">Фрагментов</dt>
                      <dd className="font-semibold">≈ {estimate.chunks}</dd>
                    </div>
                    <div>
                      <dt className="text-xs opacity-80">AI-вызовов</dt>
                      <dd className="font-semibold">≈ {estimate.calls}</dd>
                    </div>
                    <div>
                      <dt className="text-xs opacity-80">Токенов</dt>
                      <dd className="font-semibold">≈ {formatTokens(estimate.tokens)}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-xs">
                    {estimate.overThreshold
                      ? `Порог: ${
                          estimate.thresholdTokens != null
                            ? formatTokens(estimate.thresholdTokens)
                            : '—'
                        } токенов (экран AI → «Порог сметы»). Результат сохраняется по ходу — прогон можно остановить и продолжить позже.`
                      : 'В пределах порога подтверждения. Оценка уточнится по ходу прогона.'}
                  </p>
                </section>
              ) : null}
            </div>
          ) : null}

          {/* todo_20 П5.2 (mockup 06): the job was interrupted by a server restart. */}
          {phase === 'interrupted' ? (
            <div data-testid="ai-import-interrupted">
              <div
                className="flex items-start gap-3 rounded-lg p-4"
                style={{ background: 'var(--color-warning-bg)' }}
              >
                <TriangleAlert
                  className="icon mt-0.5 flex-none"
                  style={{ color: 'var(--color-warning-fg)' }}
                  aria-hidden="true"
                />
                <div style={{ color: 'var(--color-warning-fg)' }}>
                  <h4 className="text-sm font-semibold">Прогон прерван перезапуском сервера</h4>
                  <p className="mt-1 text-sm">
                    Остановился на этапе «{AI_IMPORT_STAGE_LABELS[job?.stage ?? 'unpack']}»
                    {job?.chunkIndex != null && job?.chunkTotal ? (
                      <>
                        {' '}
                        (фрагмент {job.chunkIndex} из {job.chunkTotal})
                      </>
                    ) : null}
                    . Всё созданное сохранено; продолжение начнётся с места остановки — пройденные
                    фрагменты повторно не оплачиваются.
                  </p>
                  {result ? (
                    <p className="mt-1 text-sm">
                      Уже создано: <b>{result.createdFunctions} ФТ</b>,{' '}
                      <b>{result.createdNfrs} НФТ</b>.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {phase === 'succeeded' ? (
            /* §2.18.3: summary as a TABLE with big numbers, not a one-line list. */
            <div data-testid="ai-import-success">
              <div className="mb-4 flex items-center gap-3">
                <span
                  className="grid h-10 w-10 flex-none place-items-center rounded-full"
                  style={{
                    background: 'var(--color-success-bg)',
                    color: 'var(--color-success-fg)',
                  }}
                  aria-hidden="true"
                >
                  <Check className="icon" strokeWidth={2.5} />
                </span>
                <div>
                  <h4 className="font-semibold">Анализ завершён</h4>
                  {file ? <p className="hint">{file.name}</p> : null}
                </div>
              </div>
              <table
                className="w-full overflow-hidden rounded-lg border text-sm"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-import-summary"
              >
                <caption className="sr-only">Итоги анализа документации</caption>
                <tbody>
                  <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      Создано функциональных требований
                    </th>
                    <td
                      className="px-4 py-3 text-right text-2xl font-bold tabular-nums"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      {result?.createdFunctions ?? 0}
                    </td>
                  </tr>
                  <tr
                    className="border-b"
                    style={{
                      borderColor: 'var(--color-border)',
                      background: 'var(--color-surface-2)',
                    }}
                  >
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      Создано нефункциональных требований
                    </th>
                    <td className="px-4 py-3 text-right text-2xl font-bold tabular-nums">
                      {result?.createdNfrs ?? 0}
                    </td>
                  </tr>
                  <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      Создано связей в дереве
                      <span className="hint block font-normal">
                        иерархия CHILD_OF: дерево ФТ и дерево НФТ
                      </span>
                    </th>
                    <td
                      className="px-4 py-3 text-right text-2xl font-bold tabular-nums"
                      data-testid="ai-import-tree-links"
                    >
                      {result?.links ?? 0}
                    </td>
                  </tr>
                  <tr
                    className="border-b"
                    style={{
                      borderColor: 'var(--color-border)',
                      background: 'var(--color-surface-2)',
                    }}
                  >
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      Смысловые связи НФТ↔ФТ
                      <span className="hint block font-normal">
                        {relate
                          ? 'RELATES_TO: из текста + шаг «связи ФТ↔НФТ»'
                          : 'RELATES_TO: связи по смыслу между НФТ и ФТ'}
                      </span>
                    </th>
                    <td
                      className="px-4 py-3 text-right text-2xl font-bold tabular-nums"
                      style={{ color: 'var(--color-success-fg)' }}
                      data-testid="ai-import-relates-links"
                    >
                      {relatesTotal}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      Пропущено
                      <span className="hint block font-normal">уже существовали в проекте</span>
                    </th>
                    <td
                      className="px-4 py-3 text-right text-2xl font-bold tabular-nums"
                      style={{ color: 'var(--color-text-3)' }}
                    >
                      {result?.skippedExisting ?? 0}
                    </td>
                  </tr>
                </tbody>
              </table>
              {/* Task 13 A1: «Источник» — бизнес-поле и при импорте остаётся пустым;
                  провенанс (файл/раздел) виден только в журнале анализа. */}
              <p className="hint mt-3">
                Из какого файла взято каждое требование — указано в журнале анализа.
              </p>
            </div>
          ) : null}

          {phase === 'failed' && taxonomyError && jobError ? (
            /* todo_20 П6 (mockup 04): message first, then the concrete action;
               raw technical detail lives in the collapsible block below. */
            <>
              <TaxonomyErrorCard testid="ai-import-error" error={jobError} />

              {result ? (
                <section data-testid="ai-import-error-created">
                  <h4 className="mb-2 text-sm font-semibold">Уже создано — ничего не потеряно</h4>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div
                      className="rounded-lg border px-3 py-2"
                      style={{ borderColor: 'var(--color-border)' }}
                    >
                      <div className="font-semibold">{result.createdFunctions}</div>
                      <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                        ФТ
                      </div>
                    </div>
                    <div
                      className="rounded-lg border px-3 py-2"
                      style={{ borderColor: 'var(--color-border)' }}
                    >
                      <div className="font-semibold">{result.createdNfrs}</div>
                      <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                        НФТ
                      </div>
                    </div>
                    <div
                      className="rounded-lg border px-3 py-2"
                      style={{ borderColor: 'var(--color-border)' }}
                    >
                      <div className="font-semibold">{result.links + result.relatesLinks}</div>
                      <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                        связей
                      </div>
                    </div>
                    {job?.chunkIndex != null && job?.chunkTotal ? (
                      <div
                        className="rounded-lg border px-3 py-2"
                        style={{ borderColor: 'var(--color-border)' }}
                      >
                        <div className="font-semibold">
                          {job.chunkIndex}/{job.chunkTotal}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                          фрагментов пройдено
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {smallerHintOpen ? (
                <div
                  className="rounded-lg p-3 text-sm"
                  style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                  data-testid="ai-import-smaller-chunks-hint"
                >
                  Размер фрагмента — настройка модели: откройте экран AI → «Параметры модели» и
                  уменьшите «Размер фрагмента (символов)». Затем нажмите «Продолжить» — прогон
                  возобновится с места остановки с новым размером (или запустите анализ заново).
                </div>
              ) : null}

              <TaxonomyErrorDetails
                testid="ai-import-error-details"
                error={jobError}
                contextLine={`stage: ${job?.stage ?? '—'}${
                  job?.chunkIndex != null && job?.chunkTotal
                    ? ` · fragment: ${job.chunkIndex}/${job.chunkTotal}`
                    : ''
                }${job?.currentFile ? ` · file: ${job.currentFile}` : ''}`}
              />
            </>
          ) : phase === 'failed' ? (
            <div
              className="rounded-lg border px-4 py-3"
              style={{ borderColor: 'var(--color-danger)', background: 'var(--color-danger-bg)' }}
              role="alert"
              data-testid="ai-import-error"
            >
              <div
                className="mb-1 flex items-center gap-2 text-sm font-bold"
                style={{ color: 'var(--color-danger-fg)' }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                {jobLost ? 'Задание потеряно' : `Ошибка на этапе „${stageLabel}“`}
              </div>
              <p className="mb-1 text-sm">{jobLost ? JOB_LOST_MESSAGE : job?.error?.message}</p>
              {!jobLost && job?.error?.hint ? (
                <p className="text-sm font-semibold">Что делать: {job.error.hint}</p>
              ) : null}
            </div>
          ) : null}

          {/* Ф7: honest panel after a manual stop — what was created stays on disk. */}
          {phase === 'cancelled' && result ? (
            <div data-testid="ai-import-cancelled-summary">
              <div
                className="flex items-start gap-3 rounded-lg p-4"
                style={{ background: 'var(--color-warning-bg)' }}
              >
                <CircleStop
                  className="icon mt-0.5 flex-none"
                  style={{ color: 'var(--color-warning-fg)' }}
                  aria-hidden="true"
                />
                <div style={{ color: 'var(--color-warning-fg)' }}>
                  <h4 className="text-sm font-semibold">Остановлено</h4>
                  <p className="mt-1 text-sm">
                    Анализ прерван на этапе «{currentStepLabel}». Успели создать:{' '}
                    <b>{result.createdFunctions} ФТ</b>, <b>{result.createdNfrs} НФТ</b> и{' '}
                    <b>
                      {result.links + result.relatesLinks}{' '}
                      {plural(result.links + result.relatesLinks, 'связь', 'связи', 'связей')}
                    </b>{' '}
                    — они уже сохранены в проекте.
                  </p>
                </div>
              </div>
              <p className="hint mt-3">
                Повторный анализ пропустит уже созданные требования — дубликаты не появятся.
              </p>
            </div>
          ) : null}

          {phase !== 'estimate' ? (
            <div>
              <div
                className="mb-1 flex items-center justify-between text-xs"
                style={{ color: 'var(--color-text-3)' }}
              >
                <span className="flex items-center gap-2" data-testid="ai-import-stage">
                  {phase === 'running' ? (
                    <span
                      className="spinner"
                      style={{ color: 'var(--color-primary)' }}
                      aria-hidden="true"
                    />
                  ) : null}
                  Этап: {currentStepLabel}
                  {job?.chunkIndex != null && job?.chunkTotal ? (
                    /* todo_20 E3: content-rich progress — «фрагмент X из Y». */
                    <span data-testid="ai-import-chunk">
                      · фрагмент {job.chunkIndex} из {job.chunkTotal}
                    </span>
                  ) : null}
                </span>
                <b data-testid="ai-import-progress-pct">{Math.round(progress)}%</b>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full"
                style={{ background: 'var(--color-border)' }}
                role="progressbar"
                aria-valuenow={Math.round(progress)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Прогресс анализа документации"
                data-testid="ai-import-progress"
              >
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{
                    width: `${progress}%`,
                    background:
                      phase === 'succeeded' ? 'var(--color-success)' : 'var(--color-primary)',
                  }}
                />
              </div>
              {phase === 'running' && (job?.currentFile || job?.etaSeconds !== undefined) ? (
                <p className="hint mt-1.5" data-testid="ai-import-current">
                  {job?.currentFile ? (
                    <>
                      Сейчас:{' '}
                      <span
                        className="font-medium"
                        style={{ color: 'var(--color-text-2)' }}
                        data-testid="ai-import-current-file"
                      >
                        {job.currentFile}
                      </span>
                      {job.currentClass ? (
                        <> · класс: {AI_IMPORT_SOURCE_CLASS_LABELS[job.currentClass]}</>
                      ) : null}
                    </>
                  ) : null}
                  {job?.etaSeconds !== undefined ? (
                    /* PO №6: ETA only after the first successful fragments;
                       until then the server sends null → «оценивается…». */
                    <span data-testid="ai-import-eta">
                      {job.currentFile ? ' · ' : ''}
                      {job.etaSeconds === null
                        ? 'осталось: оценивается…'
                        : job.etaSeconds > 0
                          ? `осталось ${formatEta(job.etaSeconds)}`
                          : null}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* todo_20 E3 (mockup 03): live counters of the run. */}
          {phase === 'running' && (result || usage) ? (
            <section
              className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"
              aria-label="Счётчики прогона"
              data-testid="ai-import-counters"
            >
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-import-counter-functions"
              >
                <div className="font-semibold">{result?.createdFunctions ?? 0}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  создано ФТ
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-import-counter-nfrs"
              >
                <div className="font-semibold">{result?.createdNfrs ?? 0}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  создано НФТ
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-import-counter-links"
              >
                <div className="font-semibold">
                  {(result?.links ?? 0) + (result?.relatesLinks ?? 0)}
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  связей
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-import-counter-tokens"
              >
                <div className="font-semibold">
                  {formatTokens((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0))}
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  токенов ({formatTokens(usage?.promptTokens ?? 0)} /{' '}
                  {formatTokens(usage?.completionTokens ?? 0)})
                </div>
              </div>
            </section>
          ) : null}

          {/* todo_20 E4 (mockup 05): the quality report — present (partial) also
              for failed/cancelled runs. */}
          {(phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') && report ? (
            <div className="space-y-4" data-testid="ai-import-report">
              {report.coverage.length > 0 ? (
                <section>
                  <h4 className="mb-2 text-sm font-semibold">Покрытие описи</h4>
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <table className="w-full text-sm" data-testid="ai-import-report-coverage">
                      <caption className="sr-only">Покрытие описи по классам источников</caption>
                      <thead>
                        <tr
                          className="text-left text-xs"
                          style={{
                            background: 'var(--color-surface-2)',
                            color: 'var(--color-text-2)',
                          }}
                        >
                          <th className="px-3 py-2 font-medium">Класс источника</th>
                          <th className="px-3 py-2 text-right font-medium">Обработано</th>
                          <th className="px-3 py-2 text-right font-medium">Извлечено ФТ/НФТ</th>
                          <th className="px-3 py-2 text-right font-medium">Повторные проходы</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: 'var(--color-text-2)' }}>
                        {report.coverage.map((row) => (
                          <tr
                            key={row.sourceClass}
                            className="border-t"
                            style={{ borderColor: 'var(--color-border)' }}
                            data-testid={`ai-import-coverage-${row.sourceClass}`}
                          >
                            <td className="px-3 py-2">
                              {AI_IMPORT_SOURCE_CLASS_LABELS[row.sourceClass]}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {row.processedFiles} / {row.files}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {row.extractedFunctions} / {row.extractedNfrs}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {row.retriedChunks}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              {report.blindSpots.length > 0 ? (
                <section
                  className="rounded-lg p-4"
                  style={{ background: 'var(--color-warning-bg)' }}
                  data-testid="ai-import-blindspots"
                >
                  <h4
                    className="mb-1 text-sm font-semibold"
                    style={{ color: 'var(--color-warning-fg)' }}
                  >
                    Обратите внимание
                  </h4>
                  <ul
                    className="list-disc space-y-1 pl-5 text-sm"
                    style={{ color: 'var(--color-warning-fg)' }}
                  >
                    {report.blindSpots.map((b, i) => (
                      <li key={i}>
                        {b.message}
                        {b.count > 1 ? ` — ${b.count}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {usage ? (
                <p className="hint" data-testid="ai-import-usage">
                  Потрачено токенов: {formatTokens(usage.promptTokens + usage.completionTokens)} (
                  {formatTokens(usage.promptTokens)} запросы /{' '}
                  {formatTokens(usage.completionTokens)} ответы)
                </p>
              ) : null}
            </div>
          ) : null}

          {/* B2: status of the optional relate step; hidden when not requested. */}
          {relate ? (
            <div
              className="text-sm"
              data-testid="ai-import-relate-status"
              style={{ color: relateColor }}
            >
              {RELATE_STEP_LABEL}: {relateStatusText(relate)}
            </div>
          ) : null}

          {/* Ф8: warn/error counter for the log; hidden when there is nothing to flag. */}
          {warnCount > 0 ? (
            <div>
              <span
                className="badge"
                style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }}
                data-testid="ai-import-warn-count"
              >
                <TriangleAlert size={14} aria-hidden="true" />
                Предупреждений: {warnCount}
              </span>
            </div>
          ) : null}

          {/* Live log with a header (ai-import-modal mockup, state Б).
              task24: the wrapper takes the remaining height of the large modal
              (flex-1 inside the Modal body column); the inner log keeps a
              170px floor so short content never collapses it. */}
          <div
            className="flex flex-1 flex-col overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--color-border)' }}
            data-testid="ai-import-log-panel"
          >
            <div
              className="flex shrink-0 items-center justify-between border-b px-3 py-2"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-surface-2)',
              }}
            >
              <p className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
                Журнал анализа
              </p>
              <div className="flex items-center gap-3">
                {phase === 'running' ? <p className="hint">обновляется автоматически</p> : null}
                {/* todo_20 Н4 → task24: the full technical log lives in the
                    panel header now — frees a row of height for the log itself. */}
                {logUrl ? (
                  <a
                    href={logUrl}
                    download
                    className="hint underline"
                    style={{ color: 'var(--color-primary)' }}
                    data-testid="ai-import-download-log"
                  >
                    скачать лог
                  </a>
                ) : null}
              </div>
            </div>
            <div
              ref={logRef}
              /* task24: 170px floor on mobile; on md+ the log is guaranteed a
                 300px share (body scrolls instead of squeezing it) and `grow`
                 lets it soak up the remaining height on taller screens. */
              className="min-h-[170px] shrink-0 grow basis-[170px] overflow-y-auto p-2.5 font-mono text-xs leading-relaxed md:basis-[300px]"
              style={{ background: AI_IMPORT_LOG_BG, color: AI_IMPORT_LOG_TEXT }}
              data-testid="ai-import-log"
              /* a11y (axe scrollable-region-focusable): the log overflows already
                 on running (todo_20) — keyboard users must be able to focus and
                 scroll it. role="log" also announces appended entries politely. */
              role="log"
              tabIndex={0}
              aria-label="Журнал анализа"
            >
              {(job?.log ?? []).map((entry, i) => (
                <div key={i}>
                  <span style={{ color: AI_IMPORT_LOG_LEVEL_COLOR[entry.level] }}>
                    {formatTs(entry.ts)}
                    {entry.level !== 'info' ? ` ${entry.level}` : ''}
                  </span>{' '}
                  {entry.message}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* §2.18.1: «Остановить» is not instant — mini-confirm, symmetric to closing. */}
      {stopConfirmOpen ? (
        <ConfirmDialog
          testid="ai-import-stop-confirm"
          danger
          icon={<CircleStop className="icon-sm" aria-hidden="true" />}
          title="Остановить анализ?"
          message="Созданное останется: уже сохранённые требования и связи не будут удалены."
          confirmLabel="Остановить"
          busyLabel="Останавливаем…"
          cancelLabel="Продолжить анализ"
          busy={cancelMut.isPending}
          onCancel={() => setStopConfirmOpen(false)}
          onConfirm={() => {
            stopJob();
            setStopConfirmOpen(false);
          }}
        />
      ) : null}

      {confirmOpen ? (
        <ConfirmDialog
          testid="ai-import-confirm"
          danger
          icon={<CircleStop className="icon-sm" aria-hidden="true" />}
          title="Прекратить автоматизацию?"
          message={CONFIRM_MESSAGE}
          confirmLabel="Остановить и закрыть"
          cancelLabel="Продолжить анализ"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            stopJob();
            setConfirmOpen(false);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}
