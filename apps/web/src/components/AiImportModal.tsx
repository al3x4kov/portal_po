import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiImportJobView, AiImportStage } from '@po/core';
import {
  useAiConfig,
  useAiImportJob,
  useAiModels,
  useCancelAiImport,
  useStartAiImport,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { AI_IMPORT_LOG_BG, AI_IMPORT_LOG_LEVEL_COLOR, AI_IMPORT_LOG_TEXT } from '../lib/logColors';

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

type Phase = 'setup' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export function AiImportModal({ projectId, onClose }: AiImportModalProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const configQuery = useAiConfig(projectId);
  const config = configQuery.data;
  const configured = Boolean(config?.hasApiKey);
  // Same rule as the chat widget: models are requested only once a key exists.
  const modelsQuery = useAiModels(configured);

  const startMut = useStartAiImport(projectId);
  const jobQuery = useAiImportJob(projectId, jobId);
  const cancelMut = useCancelAiImport();
  const job: AiImportJobView | undefined = jobId ? jobQuery.data : undefined;

  // Modal-selected model wins over the per-project one (spec §3.5).
  const selectedModel = modelOverride ?? config?.model ?? '';
  const modelReady = configured && selectedModel.length > 0;

  // Loaded models + the currently selected one, so the value is never lost.
  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsQuery.data?.models ?? []);
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [modelsQuery.data, selectedModel]);

  // PO-T2: the job vanished server-side (404 after a restart — jobs are
  // in-memory). Treat it as a failure with a retry, not an eternal progress.
  const jobLost = Boolean(jobId) && jobQuery.isError;
  const phase: Phase = !jobId
    ? 'setup'
    : jobLost
      ? 'failed'
      : !job || job.status === 'running'
        ? 'running'
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
    setFile(f);
    setStartError(null);
  };

  const doStart = (): void => {
    if (!file || !modelReady || startMut.isPending) return;
    setStartError(null);
    startMut.mutate(
      { file, model: modelOverride ?? undefined },
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
    if (confirmOpen) return; // Escape is already being handled by the ConfirmDialog.
    if (running) setConfirmOpen(true);
    else onClose();
  };

  /** «Повторить анализ» after a failure: back to the file-selected state. */
  const retry = (): void => {
    setJobId(null);
    startMut.reset();
  };

  const startDisabled = !file || !modelReady || startMut.isPending;
  const startTitle = !file
    ? 'Загрузите архив документации'
    : !modelReady
      ? 'Настройте AI Hub'
      : undefined;

  const startButton = (
    <button
      type="button"
      className="btn btn-primary text-sm"
      data-testid="ai-import-start"
      disabled={startDisabled}
      title={startTitle}
      onClick={doStart}
    >
      {startMut.isPending ? 'Запуск…' : 'Запустить анализ'}
    </button>
  );

  const footer =
    phase === 'setup' ? (
      startButton
    ) : phase === 'running' ? (
      <button
        type="button"
        className="btn btn-danger text-sm"
        data-testid="ai-import-stop"
        disabled={cancelMut.isPending || !jobId}
        onClick={stopJob}
      >
        Остановить
      </button>
    ) : phase === 'succeeded' ? (
      <button
        type="button"
        className="btn btn-primary text-sm"
        data-testid="ai-import-done"
        onClick={onClose}
      >
        Закрыть и перейти к проекту
      </button>
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
      /* cancelled: keep the log, allow a fresh run of the same archive. */
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-import-cancelled-close"
          onClick={onClose}
        >
          Закрыть
        </button>
        {startButton}
      </>
    );

  const progress = job?.progress ?? 0;
  const stageLabel = AI_IMPORT_STAGE_LABELS[job?.stage ?? 'unpack'];
  const result = job?.result;

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
      title="AI подгрузка ФТ и НФТ из документации"
      testid="ai-import"
      widthClass="max-w-[640px]"
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
              Перетащите архив документации сюда или{' '}
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
              <span className="text-xs">zip или tar.gz, до 50 МБ (.md/.txt внутри)</span>
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
              <select
                id="ai-import-model"
                className="input flex-1 cursor-pointer py-1.5 text-sm"
                title="Модель для анализа документации"
                data-testid="ai-import-model-select"
                value={selectedModel}
                onChange={(e) => setModelOverride(e.target.value)}
              >
                {selectedModel.length === 0 ? <option value="">— выберите модель —</option> : null}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
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
        </>
      ) : (
        <>
          {fileCard}

          {phase === 'succeeded' ? (
            <div
              className="rounded-lg border px-4 py-3"
              style={{
                borderColor: 'var(--color-success)',
                background: 'var(--color-success-bg)',
              }}
              data-testid="ai-import-success"
            >
              <div
                className="mb-1 flex items-center gap-2 text-sm font-bold"
                style={{ color: 'var(--color-success-fg)' }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Подгрузка завершена
              </div>
              <p className="text-sm">
                Создано: <b>{result?.createdFunctions ?? 0} ФТ</b> и{' '}
                <b>{result?.createdNfrs ?? 0} НФТ</b>, связей: <b>{result?.links ?? 0}</b>.
                Пропущено как существующие: {result?.skippedExisting ?? 0}. Источник каждого
                требования указан в поле «Источник».
              </p>
            </div>
          ) : null}

          {phase === 'failed' ? (
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
              <p className="mb-1 text-sm">
                {jobLost
                  ? 'Задание потеряно (сервер был перезапущен). Запустите анализ заново.'
                  : job?.error?.message}
              </p>
              {!jobLost && job?.error?.hint ? (
                <p className="text-sm font-semibold">Что делать: {job.error.hint}</p>
              ) : null}
            </div>
          ) : null}

          <div>
            <div
              className="mb-1 flex items-center justify-between text-xs"
              style={{ color: 'var(--color-text-3)' }}
            >
              <span data-testid="ai-import-stage">Этап: {stageLabel}</span>
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
          </div>

          <div
            ref={logRef}
            className="overflow-y-auto rounded-lg p-2.5 font-mono text-xs leading-relaxed"
            style={{ background: AI_IMPORT_LOG_BG, color: AI_IMPORT_LOG_TEXT, height: 170 }}
            data-testid="ai-import-log"
            aria-label="Лог автоматизации"
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
        </>
      )}

      {confirmOpen ? (
        <ConfirmDialog
          testid="ai-import-confirm"
          danger
          icon="⏹"
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
