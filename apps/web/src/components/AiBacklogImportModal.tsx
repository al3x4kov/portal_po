import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleStop, Pencil, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  AiBacklogMapping,
  AiBacklogOverride,
  AiImportJobSummary,
  AiImportJobView,
  AiImportStage,
  RequirementType,
  TargetQuarter,
} from '@po/core';
import { AI_BACKLOG_MAX_BYTES, TARGET_QUARTERS } from '@po/core';
import {
  useAiConfig,
  useAiImportJob,
  useAiImportJobs,
  useAiModelsRefresh,
  useApplyAiBacklogImport,
  useCancelAiImport,
  useConfirmAiImport,
  useRequirements,
  useResumeAiImport,
  useStartAiBacklogImport,
} from '../api/hooks';
import { aiImportApi } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { Modal } from './Modal';
import { BusyButton } from './BusyButton';
import { ConfirmDialog } from './ConfirmDialog';
import { ModelListNotice, ModelRefreshButton } from './ModelRefresh';
import { EmbeddingModelWarning, ModelSelectOptions } from './ModelSelectOptions';
import { TaxonomyErrorCard, TaxonomyErrorDetails } from './AiImportErrorBlocks';
import { AiImportHistoryList, formatDateTime } from './AiImportHistoryList';
import { formatFileSize, formatTokens } from './AiImportModal';
import { AI_IMPORT_LOG_BG, AI_IMPORT_LOG_LEVEL_COLOR, AI_IMPORT_LOG_TEXT } from '../lib/logColors';
import { plural } from '../lib/plural';

/**
 * todo_22 (T-305/T-306): «AI подгрузка из бэклога» — upload an .xlsx backlog
 * export, preview the recognized columns (deterministic parse, no AI calls),
 * confirm the shared target → batched AI match against the project tree →
 * the REVIEW gate (PO №1: nothing is written until «Записать в проект») →
 * apply the selected rows → final report. Terminology: «батч» / «строка».
 */

/** Russian stage labels of the backlog flow (same stage enum, backlog wording). */
export const AI_BACKLOG_STAGE_LABELS: Record<AiImportStage, string> = {
  unpack: 'Чтение файла',
  analyze: 'Соотнесение с деревом',
  structure: 'Соотнесение с деревом',
  aggregate: 'Соотнесение с деревом',
  populate: 'Запись в проект',
  done: 'Готово',
};

const MODEL_HINT = 'Задайте API-ключ на экране AI (меню проекта → AI), затем выберите модель.';

/** todo_22 Н1: the 10 МБ xlsx limit, derived from the contract constant. */
const MAX_XLSX_MB = Math.floor(AI_BACKLOG_MAX_BYTES / (1024 * 1024));
const FILE_TOO_BIG_MESSAGE = `Файл больше ${MAX_XLSX_MB} МБ — уменьшите выгрузку бэклога.`;
const NOT_XLSX_MESSAGE = 'Нужен файл .xlsx — выгрузка бэклога из трекера (например, Jira).';

/** Abandoned review gate blocks a new import (contract: 409 on start). */
const CONFLICT_HINT =
  'Уже есть незавершённый AI-импорт этого проекта. Если прошлый импорт бэклога ждёт выверки — ' +
  'откройте его в «Прошлых прогонах» и завершите («Записать в проект») или отмените.';

/** Ф9-pattern: a 404 on the job poll — restart-safe, human-readable text. */
const JOB_LOST_MESSAGE =
  'Статус задания недоступен (возможно, сервер был перезапущен или задание устарело). ' +
  'Запустите анализ заново.';

const CLOSE_WHILE_RUNNING_MESSAGE =
  'Анализ бэклога ещё выполняется. Если закрыть окно, процесс будет остановлен. ' +
  'До подтверждения выверки в проект ничего не записывается.';

const CANCEL_REVIEW_MESSAGE =
  'Разметка будет отброшена, в проект ничего не записано. ' +
  'Оплаченные AI-вызовы повторно использовать не получится.';

/** «батч X из Y» from the latest log line of the match stage. */
export function batchFromLog(
  log: { message: string }[],
): { current: number; total: number } | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const m = /батч (\d+)\/(\d+)/.exec(log[i]!.message);
    if (m) return { current: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}

/** ISO timestamp → local HH:MM:SS for the log gutter. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('ru-RU', { hour12: false });
}

interface AiBacklogImportModalProps {
  projectId: string;
  onClose: () => void;
}

/**
 * Local view phase. `preview` = the confirm gate (deterministic parse done,
 * no AI calls yet), `review` = the mandatory verification gate (PO №1).
 */
type Phase =
  'setup' | 'preview' | 'running' | 'review' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/**
 * task25: local (unsaved) review edits of one row. Values equal to the AI
 * proposal are never stored — a row is «изменено» iff it has an entry here.
 * Edits live in the modal state only (v1): closing the review keeps the job
 * but drops the pending edits.
 */
interface RowEdits {
  businessName?: string;
  parent?: NonNullable<AiBacklogOverride['parent']>;
  /** Always a pair — the contract requires quarter and year together. */
  target?: { quarter: TargetQuarter; year: number };
}

/** An existing tree node offered by the parent-picker (task25). */
interface NodeOption {
  name: string;
  type: RequirementType;
  /** Name of its own parent — orientation info in the picker list. */
  parentName: string | null;
}

const TYPE_SHORT: Record<RequirementType, string> = { FUNCTION: 'ФТ', NFR: 'НФТ' };

export function AiBacklogImportModal({
  projectId,
  onClose,
}: AiBacklogImportModalProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Shared target for rows without a file-provided term (PO №3).
  const [targetQuarter, setTargetQuarter] = useState<TargetQuarter>('Q1');
  const [targetYear, setTargetYear] = useState<number>(new Date().getFullYear());
  // Review selection: rowIds to write (default — everything except duplicates).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // task25: per-row review edits (business name / parent node / target term).
  const [rowEdits, setRowEdits] = useState<Record<string, RowEdits>>({});
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [cancelReviewConfirmOpen, setCancelReviewConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const configQuery = useAiConfig(projectId);
  const config = configQuery.data;
  const configured = Boolean(config?.hasApiKey);

  const startMut = useStartAiBacklogImport(projectId);
  const jobQuery = useAiImportJob(projectId, jobId);
  const cancelMut = useCancelAiImport();
  const confirmMut = useConfirmAiImport();
  const applyMut = useApplyAiBacklogImport();
  const resumeMut = useResumeAiImport(projectId);
  const historyQuery = useAiImportJobs(projectId);
  const historyJobs: AiImportJobSummary[] = historyQuery.data?.jobs ?? [];
  const job: AiImportJobView | undefined = jobId ? jobQuery.data : undefined;

  const selectedModel = modelOverride ?? config?.model ?? '';
  const modelReady = configured && selectedModel.length > 0;

  const modelsRefresh = useAiModelsRefresh({
    enabled: configured,
    selectedModel,
    fallbackModel: config?.model,
    onModelReset: setModelOverride,
  });

  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsRefresh.models);
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [modelsRefresh.models, selectedModel]);

  const jobLost = Boolean(jobId) && jobQuery.isError;
  const phase: Phase = !jobId
    ? 'setup'
    : jobLost
      ? 'failed'
      : !job || job.status === 'running'
        ? 'running'
        : job.status === 'awaiting-confirmation'
          ? 'preview'
          : job.status === 'awaiting-review'
            ? 'review'
            : job.status;
  const running = phase === 'running' || startMut.isPending;

  const preview = job?.backlogPreview;
  const review = job?.backlogReview;
  const report = job?.backlogReport;
  const usage = job?.usage;
  const result = job?.result;

  // Default target = next calendar quarter, computed server-side (contract).
  const targetInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (jobId && preview && targetInitRef.current !== jobId) {
      targetInitRef.current = jobId;
      setTargetQuarter(preview.defaultTarget.quarter);
      setTargetYear(preview.defaultTarget.year);
    }
  }, [jobId, preview]);

  // Review selection default: all rows except duplicates (T-306).
  const selectionInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (jobId && review && phase === 'review' && selectionInitRef.current !== jobId) {
      selectionInitRef.current = jobId;
      setSelected(new Set(review.mappings.filter((m) => !m.duplicateOf).map((m) => m.rowId)));
      // task25: pending edits belong to one review of one job.
      setRowEdits({});
    }
  }, [jobId, review, phase]);

  // Autoscroll the events feed to the latest line.
  const logLength = job?.log.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLength]);

  const pickFile = (f: File | null | undefined): void => {
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      setStartError(NOT_XLSX_MESSAGE);
      return;
    }
    if (f.size > AI_BACKLOG_MAX_BYTES) {
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
      { file, model: modelOverride ?? undefined },
      {
        onSuccess: (res) => setJobId(res.jobId),
        onError: (err) => {
          // Contract: 409 while another import (e.g. an abandoned review
          // gate) is unfinished — tell the user HOW to unblock it.
          if (err instanceof ApiError && err.status === 409) {
            setStartError(`${CONFLICT_HINT} (${err.message})`);
          } else {
            setStartError(errorMessage(err));
          }
        },
      },
    );
  };

  const stopJob = (): void => {
    if (jobId) cancelMut.mutate(jobId);
  };

  /** «Начать анализ» on the preview gate: confirm with the shared target. */
  const confirmStart = (): void => {
    if (!jobId || confirmMut.isPending) return;
    confirmMut.mutate({ jobId, target: { targetQuarter, targetYear } });
  };

  /**
   * «Записать в проект (N)» — the ONLY write of the whole flow. task25: the
   * body carries `overrides` only for the selected rows that really differ
   * from the AI proposal; a 400 (invalid override) lands in the same inline
   * error block and keeps the review step alive.
   */
  const doApply = (): void => {
    if (!jobId || selected.size === 0 || applyMut.isPending) return;
    setApplyError(null);
    const overrides = buildOverrides();
    applyMut.mutate(
      {
        jobId,
        rowIds: [...selected],
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      },
      {
        // The server merged the edits into the saved mappings — local pending
        // edits are now redundant (the fresh view already shows them).
        onSuccess: () => setRowEdits({}),
        onError: (err) => setApplyError(errorMessage(err)),
      },
    );
  };

  /** X / overlay / Escape: running guards with a confirm, gates keep the job. */
  const requestClose = (): void => {
    if (closeConfirmOpen || stopConfirmOpen || cancelReviewConfirmOpen) return;
    if (phase === 'preview') {
      // No AI calls have started yet — cancel silently and close (free).
      stopJob();
      onClose();
      return;
    }
    if (phase === 'review') {
      // The paid markup must NOT be discarded by an accidental close: the job
      // stays on the review gate and reopens from «Прошлые прогоны».
      onClose();
      return;
    }
    if (running) setCloseConfirmOpen(true);
    else onClose();
  };

  /** «Повторить анализ» after a failure: back to the file-selected state. */
  const retry = (): void => {
    setJobId(null);
    setApplyError(null);
    startMut.reset();
    resumeMut.reset();
  };

  /** Resume a failed/interrupted match from its checkpoint (paid batches kept). */
  const resumeJob = (id?: string): void => {
    const target = id ?? jobId;
    if (!target || resumeMut.isPending) return;
    resumeMut.mutate(target, {
      onSuccess: ({ jobId: resumedId }) => setJobId(resumedId),
    });
  };

  /** Open a past run (review gate / report / log) in this modal. */
  const openHistoryJob = (id: string): void => {
    resumeMut.reset();
    setApplyError(null);
    setJobId(id);
  };

  const startDisabled = !file || !modelReady || startMut.isPending;
  const setupHint = !file
    ? 'Загрузите файл .xlsx с бэклогом'
    : !modelReady
      ? 'Настройте AI Hub'
      : 'Файл выбран — можно начинать';

  const jobError = jobLost ? undefined : job?.error;
  const taxonomyError = Boolean(jobError?.code);
  const resumable = Boolean(jobError?.resumable) && !jobLost;
  const logUrl = jobId && !jobLost ? aiImportApi.logUrl(jobId) : null;

  const progress = job?.progress ?? 0;
  const stageLabel = AI_BACKLOG_STAGE_LABELS[job?.stage ?? 'unpack'];
  const batch = useMemo(() => batchFromLog(job?.log ?? []), [job?.log]);
  const duplicatesKnown = report?.duplicatesSkipped ?? review?.duplicates ?? 0;

  const mappings: AiBacklogMapping[] = review?.mappings ?? [];
  const selectableIds = useMemo(
    () => mappings.filter((m) => !m.duplicateOf).map((m) => m.rowId),
    [mappings],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleRow = (rowId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };

  /* ── task25 · review edits ─────────────────────────────────────────────── */

  // The parent-picker searches the REAL project tree — load it only on review.
  const requirementsQuery = useRequirements(phase === 'review' ? projectId : undefined);
  const nodeOptions = useMemo<NodeOption[]>(() => {
    const reqs = requirementsQuery.data?.requirements ?? [];
    // Slugs are unique within (project × type); CHILD_OF stays inside a type.
    const nameByTypeSlug = new Map(reqs.map((r) => [`${r.type}:${r.slug}`, r.name]));
    return reqs.map((r) => {
      const childOf = r.links.find((l) => l.type === 'CHILD_OF');
      return {
        name: r.name,
        type: r.type,
        parentName: childOf
          ? (nameByTypeSlug.get(`${r.type}:${childOf.targetSlug}`) ?? null)
          : null,
      };
    });
  }, [requirementsQuery.data]);

  /** Merge an edit patch into the row entry; empty entries are dropped. */
  const patchRow = (rowId: string, patch: (prev: RowEdits) => RowEdits): void => {
    setRowEdits((prev) => {
      const entry = patch(prev[rowId] ?? {});
      const next = { ...prev };
      if (Object.keys(entry).length === 0) delete next[rowId];
      else next[rowId] = entry;
      return next;
    });
  };

  /** Save the inline-edited business name; the original value clears the edit. */
  const saveBusinessName = (m: AiBacklogMapping, name: string): void => {
    patchRow(m.rowId, ({ businessName: _prev, ...rest }) =>
      name === m.businessName ? rest : { ...rest, businessName: name },
    );
  };

  /** Reparent the row (existing node or a new root node with a custom name). */
  const saveParent = (m: AiBacklogMapping, parent: NonNullable<RowEdits['parent']>): void => {
    patchRow(m.rowId, ({ parent: _prev, ...rest }) =>
      parent.kind === m.parent.kind && parent.name === m.parent.name ? rest : { ...rest, parent },
    );
  };

  /** Drop the parent edit — back to the AI proposal («вернуть предложенное»). */
  const resetParent = (rowId: string): void => {
    patchRow(rowId, ({ parent: _prev, ...rest }) => rest);
  };

  /** Per-row «Срок реализации»: quarter + year always travel as a pair. */
  const saveTarget = (m: AiBacklogMapping, quarter: TargetQuarter, year: number): void => {
    patchRow(m.rowId, ({ target: _prev, ...rest }) =>
      quarter === m.targetQuarter && year === m.targetYear
        ? rest
        : { ...rest, target: { quarter, year } },
    );
  };

  /** Overrides for the apply body: selected rows with a real difference only. */
  const buildOverrides = (): Record<string, AiBacklogOverride> => {
    const out: Record<string, AiBacklogOverride> = {};
    for (const m of mappings) {
      if (!selected.has(m.rowId)) continue;
      const edits = rowEdits[m.rowId];
      if (!edits) continue;
      const entry: AiBacklogOverride = {};
      if (edits.businessName !== undefined && edits.businessName !== m.businessName) {
        entry.businessName = edits.businessName;
      }
      if (
        edits.parent &&
        (edits.parent.kind !== m.parent.kind || edits.parent.name !== m.parent.name)
      ) {
        entry.parent = edits.parent;
      }
      if (
        edits.target &&
        (edits.target.quarter !== m.targetQuarter || edits.target.year !== m.targetYear)
      ) {
        entry.targetQuarter = edits.target.quarter;
        entry.targetYear = edits.target.year;
      }
      if (Object.keys(entry).length > 0) out[m.rowId] = entry;
    }
    return out;
  };

  const footer =
    phase === 'setup' ? (
      <>
        <p className="hint mr-auto self-center" data-testid="ai-backlog-footer-hint">
          {setupHint}
        </p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-cancel"
          onClick={onClose}
        >
          Отмена
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={startMut.isPending}
          busyLabel="Загружаем…"
          data-testid="ai-backlog-start"
          disabled={startDisabled}
          title={!file ? 'Загрузите файл бэклога' : !modelReady ? 'Настройте AI Hub' : undefined}
          onClick={doStart}
        >
          Загрузить и разобрать
        </BusyButton>
      </>
    ) : phase === 'preview' ? (
      <>
        <p className="hint mr-auto self-center">AI-вызовы ещё не начались — отмена бесплатна</p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-preview-cancel"
          disabled={cancelMut.isPending}
          onClick={() => {
            stopJob();
            onClose();
          }}
        >
          Отмена
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={confirmMut.isPending}
          busyLabel="Запускаем…"
          data-testid="ai-backlog-confirm-start"
          onClick={confirmStart}
        >
          Начать анализ
        </BusyButton>
      </>
    ) : phase === 'running' ? (
      <>
        <p className="hint mr-auto self-center">
          Разметка сохраняется после каждого батча — остановку можно продолжить позже
        </p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          style={{ color: 'var(--color-danger-fg)' }}
          data-testid="ai-backlog-stop"
          disabled={cancelMut.isPending || !jobId}
          onClick={() => setStopConfirmOpen(true)}
        >
          <CircleStop className="icon-sm" aria-hidden="true" />
          Остановить
        </button>
      </>
    ) : phase === 'review' ? (
      <>
        <p className="hint mr-auto self-center">
          Запись начнётся только после подтверждения. Источник: «Бэклог:{' '}
          {preview?.fileName ?? 'файл'}» (тип «Бэклог»).
        </p>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-review-cancel"
          disabled={cancelMut.isPending}
          onClick={() => setCancelReviewConfirmOpen(true)}
        >
          Отмена
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={applyMut.isPending}
          busyLabel="Записываем…"
          data-testid="ai-backlog-apply"
          disabled={selected.size === 0 || applyMut.isPending}
          title={selected.size === 0 ? 'Выберите хотя бы одну строку' : undefined}
          onClick={doApply}
        >
          Записать в проект ({selected.size})
        </BusyButton>
      </>
    ) : phase === 'interrupted' ? (
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-error-close"
          onClick={onClose}
        >
          Закрыть
        </button>
        <BusyButton
          className="btn btn-primary text-sm"
          busy={resumeMut.isPending}
          busyLabel="Продолжаем…"
          data-testid="ai-backlog-resume"
          onClick={() => resumeJob()}
        >
          Продолжить
        </BusyButton>
      </>
    ) : phase === 'succeeded' ? (
      <button
        type="button"
        className="btn btn-primary text-sm"
        data-testid="ai-backlog-done"
        onClick={onClose}
      >
        Готово
      </button>
    ) : phase === 'failed' ? (
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-error-close"
          onClick={onClose}
        >
          Закрыть
        </button>
        {resumable ? (
          <BusyButton
            className="btn btn-primary text-sm"
            busy={resumeMut.isPending}
            busyLabel="Продолжаем…"
            data-testid="ai-backlog-resume"
            onClick={() => resumeJob()}
          >
            Продолжить
          </BusyButton>
        ) : (
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="ai-backlog-retry"
            onClick={retry}
          >
            Повторить анализ
          </button>
        )}
      </>
    ) : (
      /* cancelled */
      <>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="ai-backlog-retry"
          onClick={retry}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Повторить анализ
        </button>
        <button
          type="button"
          className="btn btn-primary text-sm"
          data-testid="ai-backlog-done"
          onClick={onClose}
        >
          Готово
        </button>
      </>
    );

  const sampleHasKeys = (preview?.sampleRows ?? []).some((r) => r.key);

  return (
    <Modal
      title="AI-импорт бэклога"
      testid="ai-backlog-import"
      widthClass="max-w-[640px]"
      size="large"
      onClose={requestClose}
      onOverlayClick={requestClose}
      footer={footer}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx"
        className="sr-only"
        aria-label="Файл бэклога (.xlsx)"
        data-testid="ai-backlog-file"
        onChange={(e) => {
          pickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {phase === 'setup' ? (
        <>
          {file ? (
            <div
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <div className="min-w-0 text-sm" data-testid="ai-backlog-file-name">
                <span className="font-bold">{file.name}</span>{' '}
                <span style={{ color: 'var(--color-text-3)' }}>· {formatFileSize(file.size)}</span>
              </div>
              <button
                type="button"
                className="shrink-0 text-sm font-semibold"
                style={{ color: 'var(--color-primary)' }}
                data-testid="ai-backlog-replace"
                onClick={() => fileInputRef.current?.click()}
              >
                Заменить
              </button>
            </div>
          ) : (
            <div
              className="rounded-[10px] border-2 border-dashed px-4 py-5 text-center text-sm"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-3)' }}
              data-testid="ai-backlog-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files?.[0]);
              }}
            >
              Перетащите файл бэклога сюда или{' '}
              <button
                type="button"
                className="font-semibold"
                style={{ color: 'var(--color-primary)' }}
                data-testid="ai-backlog-browse"
                onClick={() => fileInputRef.current?.click()}
              >
                выберите файл
              </button>
              <br />
              <span className="text-xs">
                .xlsx (выгрузка из трекера), до {MAX_XLSX_MB} МБ / 5000 строк
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label
              htmlFor="ai-backlog-model"
              className="shrink-0 text-sm"
              style={{ color: 'var(--color-text-3)' }}
            >
              Модель:
            </label>
            {configured ? (
              <>
                <select
                  id="ai-backlog-model"
                  className="input min-w-0 flex-1 cursor-pointer py-1.5 text-sm"
                  title="Модель для соотнесения строк бэклога"
                  data-testid="ai-backlog-model-select"
                  value={selectedModel}
                  onChange={(e) => {
                    modelsRefresh.clearNotice();
                    setModelOverride(e.target.value);
                  }}
                >
                  {selectedModel.length === 0 ? (
                    <option value="">— выберите модель —</option>
                  ) : null}
                  <ModelSelectOptions
                    models={modelOptions}
                    embeddingGroupTestid="ai-backlog-embedding-group"
                  />
                </select>
                <ModelRefreshButton
                  testid="ai-models-refresh-backlog"
                  className="btn btn-secondary px-2.5 py-1.5"
                  refreshing={modelsRefresh.isFetching}
                  onClick={() => void modelsRefresh.refresh()}
                />
              </>
            ) : (
              <div
                className="min-w-0 flex-1"
                title={MODEL_HINT}
                data-testid="ai-backlog-model-hint"
              >
                <select
                  id="ai-backlog-model"
                  className="input w-full cursor-not-allowed py-1.5 text-sm opacity-50"
                  disabled
                  data-testid="ai-backlog-model-select"
                >
                  <option>Модель не настроена</option>
                </select>
              </div>
            )}
          </div>

          {/* Stored config may predate the embedding guard — warn, don't break. */}
          <EmbeddingModelWarning model={selectedModel} testid="ai-backlog-embedding-warning" />

          <ModelListNotice testid="ai-models-notice-backlog" notice={modelsRefresh.notice} />

          {startError ? (
            <div
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              role="alert"
              data-testid="ai-backlog-start-error"
            >
              {startError}
            </div>
          ) : null}

          {(() => {
            const interrupted = historyJobs.find(
              (j) => j.status === 'interrupted' && j.kind === 'backlog',
            );
            if (!interrupted) return null;
            return (
              <div
                className="flex items-start justify-between gap-3 rounded-lg p-3"
                style={{ background: 'var(--color-warning-bg)' }}
                data-testid="ai-backlog-interrupted-banner"
              >
                <div className="text-sm" style={{ color: 'var(--color-warning-fg)' }}>
                  <b>Найден незавершённый импорт бэклога</b> — прерван перезапуском сервера{' '}
                  {formatDateTime(interrupted.startedAt)}. Размеченные батчи сохранены; продолжение
                  начнётся с места остановки.
                </div>
                <BusyButton
                  className="btn btn-primary shrink-0 text-sm"
                  busy={resumeMut.isPending}
                  busyLabel="Продолжаем…"
                  data-testid="ai-backlog-interrupted-resume"
                  onClick={() => resumeJob(interrupted.jobId)}
                >
                  Продолжить
                </BusyButton>
              </div>
            );
          })()}

          {/* Shared run history (docs + backlog) with the kind badge (T-306). */}
          <AiImportHistoryList
            testidPrefix="ai-backlog"
            jobs={historyJobs}
            resumePending={resumeMut.isPending}
            onResume={resumeJob}
            onOpen={openHistoryJob}
          />
        </>
      ) : phase === 'preview' && preview ? (
        /* П2 (mockup 01): deterministic parse result — the confirm gate. */
        <div className="space-y-5" data-testid="ai-backlog-preview-step">
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="min-w-0 text-sm" data-testid="ai-backlog-file-name">
              <span className="font-bold">{preview.fileName}</span>
              {file ? (
                <span style={{ color: 'var(--color-text-3)' }}> · {formatFileSize(file.size)}</span>
              ) : null}
            </div>
          </div>

          <section aria-labelledby="ai-backlog-cols-h">
            <h4 id="ai-backlog-cols-h" className="mb-2 text-sm font-semibold">
              Распознанные колонки
            </h4>
            <div className="flex flex-wrap gap-2 text-sm">
              {preview.columns.keyColumn ? (
                <span
                  className="rounded-full px-3 py-1"
                  style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                  data-testid="ai-backlog-col-key"
                >
                  Ключ: {preview.columns.keyColumn}
                </span>
              ) : null}
              <span
                className="rounded-full px-3 py-1"
                style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                data-testid="ai-backlog-col-text"
              >
                Формулировка: {preview.columns.textColumn}
              </span>
              {preview.columns.targetColumn ? (
                <span
                  className="rounded-full px-3 py-1"
                  style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                  data-testid="ai-backlog-col-target"
                >
                  Срок: {preview.columns.targetColumn}
                </span>
              ) : null}
            </div>
            <p className="hint mt-1.5">
              Колонки определены по содержимому. Остальные колонки игнорируются.
            </p>
          </section>

          <section aria-labelledby="ai-backlog-sample-h">
            <h4
              id="ai-backlog-sample-h"
              className="mb-2 text-sm font-semibold"
              data-testid="ai-backlog-rows-summary"
            >
              Первые строки — {preview.totalRows}{' '}
              {plural(preview.totalRows, 'строка', 'строки', 'строк')} к обработке
              {preview.skippedRows > 0 ? `, ${preview.skippedRows} пустых пропущено` : ''}
            </h4>
            <div
              className="overflow-hidden rounded-lg border"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <table className="w-full text-sm" data-testid="ai-backlog-sample-table">
                <caption className="sr-only">Первые строки бэклога</caption>
                <thead>
                  <tr
                    className="text-left text-xs"
                    style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
                  >
                    {sampleHasKeys ? <th className="w-32 px-3 py-2 font-medium">Ключ</th> : null}
                    <th className="px-3 py-2 font-medium">Формулировка</th>
                  </tr>
                </thead>
                <tbody style={{ color: 'var(--color-text-2)' }}>
                  {preview.sampleRows.map((r) => (
                    <tr
                      key={r.rowId}
                      className="border-t"
                      style={{ borderColor: 'var(--color-border)' }}
                      data-testid="ai-backlog-sample-row"
                    >
                      {sampleHasKeys ? (
                        <td className="px-3 py-1.5 font-mono text-xs">{r.key ?? ''}</td>
                      ) : null}
                      <td className="px-3 py-1.5">{r.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* PO №3: file target wins per row; the shared choice covers the rest. */}
          <section className="flex flex-wrap items-center gap-3">
            <label htmlFor="ai-backlog-target-quarter" className="text-sm font-medium">
              Целевой квартал/год для строк без срока в файле:
            </label>
            <select
              id="ai-backlog-target-quarter"
              className="input w-auto cursor-pointer py-1.5 text-sm"
              data-testid="ai-backlog-target-quarter"
              value={targetQuarter}
              onChange={(e) => setTargetQuarter(e.target.value as TargetQuarter)}
            >
              {TARGET_QUARTERS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <input
              type="number"
              className="input w-24 py-1.5 text-sm"
              aria-label="Год"
              data-testid="ai-backlog-target-year"
              min={2020}
              max={2100}
              value={targetYear}
              onChange={(e) => setTargetYear(Number(e.target.value))}
            />
            <span className="hint" data-testid="ai-backlog-target-hint">
              {preview.columns.targetColumn
                ? `сроки найдены в файле — выбор применяется только к строкам без срока`
                : 'в файле сроки не найдены'}
            </span>
          </section>

          <section
            className="rounded-lg p-4"
            style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
            data-testid="ai-backlog-estimate"
          >
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs opacity-80">Строк</dt>
                <dd className="font-semibold">{preview.totalRows}</dd>
              </div>
              <div>
                <dt className="text-xs opacity-80">AI-вызовов</dt>
                <dd className="font-semibold">≈ {preview.estimate.calls}</dd>
              </div>
              <div>
                <dt className="text-xs opacity-80">Токенов</dt>
                <dd className="font-semibold">≈ {formatTokens(preview.estimate.tokens)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs">
              Каждая строка будет соотнесена с деревом ФТ/НФТ: имя перепишется в бизнес-формат,
              исходная формулировка и ключ сохранятся в описании, требование встроится в подходящий
              узел. Перед записью вы проверите разметку.
            </p>
          </section>
        </div>
      ) : phase === 'review' && review ? (
        /* PO №1 (mockup 04): the mandatory review gate — nothing written yet. */
        <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="ai-backlog-review-step">
          {review.newNodes.length > 0 ? (
            <section
              className="rounded-lg p-4"
              style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
              data-testid="ai-backlog-new-nodes"
            >
              <h4 className="mb-2 text-sm font-semibold">
                Будут созданы новые узлы дерева ({review.newNodes.length})
              </h4>
              <ul className="space-y-1 text-sm">
                {review.newNodes.map((n) => (
                  <li key={n.name} data-testid="ai-backlog-new-node">
                    • <b>{n.name}</b> — {n.parentName ? `под «${n.parentName}»` : 'корневой узел'} (
                    {n.rowCount} {plural(n.rowCount, 'строка', 'строки', 'строк')})
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">
                Каждый новый узел — бизнес-функция продукта; технические группировки запрещены.
              </p>
            </section>
          ) : null}

          {applyError ? (
            <div
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              role="alert"
              data-testid="ai-backlog-apply-error"
            >
              {applyError}
            </div>
          ) : null}

          <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="ai-backlog-review-h">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 id="ai-backlog-review-h" className="text-sm font-semibold">
                Соответствия — снимите галочку, чтобы не записывать строку
              </h4>
              <span className="hint" data-testid="ai-backlog-selected-count">
                выбрано {selected.size} из {mappings.length}
              </span>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto rounded-lg border"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <table className="w-full text-sm" data-testid="ai-backlog-review-table">
                <caption className="sr-only">Разметка строк бэклога перед записью</caption>
                <thead className="sticky top-0">
                  <tr
                    className="text-left text-xs"
                    style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
                  >
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Выбрать все строки"
                        data-testid="ai-backlog-select-all"
                        checked={allSelected}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">Исходная формулировка</th>
                    <th className="px-3 py-2 font-medium">Бизнес-имя</th>
                    <th className="px-3 py-2 font-medium">Узел (куда встроится)</th>
                    <th className="w-44 px-3 py-2 font-medium">Срок реализации</th>
                  </tr>
                </thead>
                <tbody style={{ color: 'var(--color-text-2)' }}>
                  {mappings.map((m) => {
                    const isDuplicate = Boolean(m.duplicateOf);
                    const isSelected = selected.has(m.rowId);
                    return (
                      <tr
                        key={m.rowId}
                        className="border-t align-top"
                        style={{
                          borderColor: 'var(--color-border)',
                          opacity: isDuplicate || !isSelected ? 0.6 : undefined,
                        }}
                        data-testid="ai-backlog-review-row"
                        data-rowid={m.rowId}
                        data-selected={isSelected}
                      >
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Записать строку «${m.sourceText}»`}
                            data-testid="ai-backlog-row-checkbox"
                            checked={isSelected}
                            disabled={isDuplicate}
                            onChange={() => toggleRow(m.rowId)}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          {m.key ? (
                            <span
                              className="mr-1.5 font-mono text-xs"
                              style={{ color: 'var(--color-text-3)' }}
                            >
                              {m.key}
                            </span>
                          ) : null}
                          {m.sourceText}
                        </td>
                        <td className="px-3 py-1.5">
                          {isDuplicate ? (
                            m.businessName
                          ) : (
                            <BusinessNameEditor
                              name={rowEdits[m.rowId]?.businessName ?? m.businessName}
                              onSave={(name) => saveBusinessName(m, name)}
                            />
                          )}{' '}
                          {m.type === 'NFR' ? (
                            <span
                              className="badge"
                              style={{
                                background: 'var(--color-info-bg)',
                                color: 'var(--color-info-fg)',
                              }}
                              data-testid="ai-backlog-badge-nfr"
                            >
                              НФТ
                            </span>
                          ) : null}{' '}
                          {isDuplicate ? (
                            <span
                              className="badge"
                              style={{
                                background: 'var(--color-warning-bg)',
                                color: 'var(--color-warning-fg)',
                              }}
                              data-testid="ai-backlog-badge-duplicate"
                            >
                              дубль
                            </span>
                          ) : null}{' '}
                          {rowEdits[m.rowId] ? (
                            <span
                              className="badge"
                              style={{
                                background: 'var(--color-warning-bg)',
                                color: 'var(--color-warning-fg)',
                              }}
                              title="строка отредактирована — в проект запишутся новые значения"
                              data-testid="ai-backlog-row-edited"
                            >
                              изменено
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5">
                          {isDuplicate ? (
                            <span style={{ color: 'var(--color-text-3)' }}>
                              — не будет записана (есть «{m.duplicateOf}»)
                            </span>
                          ) : (
                            <ParentEditor
                              parent={rowEdits[m.rowId]?.parent ?? m.parent}
                              overridden={Boolean(rowEdits[m.rowId]?.parent)}
                              options={nodeOptions.filter((o) => o.type === m.type)}
                              typeLabel={TYPE_SHORT[m.type]}
                              loading={requirementsQuery.isLoading}
                              onPick={(p) => saveParent(m, p)}
                              onReset={() => resetParent(m.rowId)}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs" data-testid="ai-backlog-row-target">
                          {isDuplicate ? null : (
                            <TargetEditor
                              quarter={rowEdits[m.rowId]?.target?.quarter ?? m.targetQuarter}
                              year={rowEdits[m.rowId]?.target?.year ?? m.targetYear}
                              fromFile={m.targetFromFile}
                              overridden={Boolean(rowEdits[m.rowId]?.target)}
                              onChange={(q, y) => saveTarget(m, q, y)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
        /* running / succeeded / failed / cancelled / interrupted */
        <>
          {phase === 'interrupted' ? (
            <div
              className="flex items-start gap-3 rounded-lg p-4"
              style={{ background: 'var(--color-warning-bg)' }}
              data-testid="ai-backlog-interrupted"
            >
              <TriangleAlert
                className="icon mt-0.5 flex-none"
                style={{ color: 'var(--color-warning-fg)' }}
                aria-hidden="true"
              />
              <div style={{ color: 'var(--color-warning-fg)' }}>
                <h4 className="text-sm font-semibold">Импорт прерван перезапуском сервера</h4>
                <p className="mt-1 text-sm">
                  Остановился на этапе «{stageLabel}». Размеченные батчи сохранены; продолжение
                  начнётся с места остановки — пройденные батчи повторно не оплачиваются.
                </p>
              </div>
            </div>
          ) : null}

          {phase === 'succeeded' && report ? (
            /* Mockup 03: final report — counters + the mapping table. */
            <div className="space-y-4" data-testid="ai-backlog-success">
              <div className="flex items-center gap-3">
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
                  <h4 className="font-semibold">AI-импорт бэклога завершён</h4>
                  {preview ? <p className="hint">{preview.fileName}</p> : null}
                </div>
              </div>

              <section
                className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-6"
                aria-label="Итоги импорта бэклога"
                data-testid="ai-backlog-report"
              >
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: 'var(--color-success-bg)',
                    color: 'var(--color-success-fg)',
                  }}
                  data-testid="ai-backlog-report-functions"
                >
                  <div className="font-semibold">{report.created.functions}</div>
                  <div className="text-xs">создано ФТ</div>
                </div>
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: 'var(--color-success-bg)',
                    color: 'var(--color-success-fg)',
                  }}
                  data-testid="ai-backlog-report-nfrs"
                >
                  <div className="font-semibold">{report.created.nfrs}</div>
                  <div className="text-xs">создано НФТ</div>
                </div>
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: 'var(--color-success-bg)',
                    color: 'var(--color-success-fg)',
                  }}
                  data-testid="ai-backlog-report-links"
                >
                  <div className="font-semibold">{report.created.links}</div>
                  <div className="text-xs">связей</div>
                </div>
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--color-border)' }}
                  data-testid="ai-backlog-report-new-nodes"
                >
                  <div className="font-semibold">{report.created.newNodes}</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                    новых узлов дерева
                  </div>
                </div>
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--color-border)' }}
                  data-testid="ai-backlog-report-duplicates"
                >
                  <div className="font-semibold">{report.duplicatesSkipped}</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                    дублей пропущено
                  </div>
                </div>
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--color-border)' }}
                  data-testid="ai-backlog-report-deselected"
                >
                  <div className="font-semibold">{report.deselected}</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                    строк не выбрано
                  </div>
                </div>
              </section>

              {mappings.length > 0 ? (
                <section aria-labelledby="ai-backlog-report-map-h">
                  <h4 id="ai-backlog-report-map-h" className="mb-2 text-sm font-semibold">
                    Соответствия ({report.rowsTotal}{' '}
                    {plural(report.rowsTotal, 'строка', 'строки', 'строк')})
                  </h4>
                  <div
                    className="max-h-72 overflow-y-auto rounded-lg border"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <table className="w-full text-sm" data-testid="ai-backlog-report-table">
                      <caption className="sr-only">Соответствия строк бэклога</caption>
                      <thead className="sticky top-0">
                        <tr
                          className="text-left text-xs"
                          style={{
                            background: 'var(--color-surface-2)',
                            color: 'var(--color-text-2)',
                          }}
                        >
                          <th className="px-3 py-2 font-medium">Исходная формулировка</th>
                          <th className="px-3 py-2 font-medium">Бизнес-имя</th>
                          <th className="px-3 py-2 font-medium">Родительский узел</th>
                          <th className="w-28 px-3 py-2 font-medium">Срок реализации</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: 'var(--color-text-2)' }}>
                        {mappings.map((m) => (
                          <tr
                            key={m.rowId}
                            className="border-t align-top"
                            style={{ borderColor: 'var(--color-border)' }}
                            data-testid="ai-backlog-report-row"
                          >
                            <td className="px-3 py-1.5">
                              {m.key ? (
                                <span
                                  className="mr-1.5 font-mono text-xs"
                                  style={{ color: 'var(--color-text-3)' }}
                                >
                                  {m.key}
                                </span>
                              ) : null}
                              {m.sourceText}
                            </td>
                            <td className="px-3 py-1.5">
                              {m.businessName}{' '}
                              {m.type === 'NFR' ? (
                                <span
                                  className="badge"
                                  style={{
                                    background: 'var(--color-info-bg)',
                                    color: 'var(--color-info-fg)',
                                  }}
                                  data-testid="ai-backlog-badge-nfr"
                                >
                                  НФТ
                                </span>
                              ) : null}{' '}
                              {m.duplicateOf ? (
                                <span
                                  className="badge"
                                  style={{
                                    background: 'var(--color-warning-bg)',
                                    color: 'var(--color-warning-fg)',
                                  }}
                                  data-testid="ai-backlog-badge-duplicate"
                                >
                                  дубль
                                </span>
                              ) : null}
                            </td>
                            <td className="px-3 py-1.5">
                              {m.duplicateOf ? (
                                <span style={{ color: 'var(--color-text-3)' }}>
                                  — пропущено (есть «{m.duplicateOf}»)
                                </span>
                              ) : (
                                <>
                                  {m.parent.name}{' '}
                                  {m.parent.kind === 'new' ? (
                                    <span
                                      className="badge"
                                      style={{
                                        background: 'var(--color-info-bg)',
                                        color: 'var(--color-info-fg)',
                                      }}
                                      data-testid="ai-backlog-badge-new-node"
                                    >
                                      новый узел
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-xs">
                              {m.duplicateOf ? null : `${m.targetQuarter} ${m.targetYear}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="hint mt-1.5">
                    Исходная формулировка и ключ сохранены в описании каждого требования; источник —
                    «Бэклог: {preview?.fileName ?? 'файл'}».
                  </p>
                </section>
              ) : null}

              {usage ? (
                <p className="hint" data-testid="ai-backlog-usage">
                  Потрачено токенов: {formatTokens(usage.promptTokens + usage.completionTokens)} (
                  {formatTokens(usage.promptTokens)} запросы /{' '}
                  {formatTokens(usage.completionTokens)} ответы)
                </p>
              ) : null}
            </div>
          ) : null}

          {phase === 'failed' && taxonomyError && jobError ? (
            <>
              <TaxonomyErrorCard testid="ai-backlog-error" error={jobError} />
              <TaxonomyErrorDetails
                testid="ai-backlog-error-details"
                error={jobError}
                contextLine={`stage: ${job?.stage ?? '—'}${
                  batch ? ` · batch: ${batch.current}/${batch.total}` : ''
                }`}
              />
            </>
          ) : phase === 'failed' ? (
            <div
              className="rounded-lg border px-4 py-3"
              style={{ borderColor: 'var(--color-danger)', background: 'var(--color-danger-bg)' }}
              role="alert"
              data-testid="ai-backlog-error"
            >
              <div
                className="mb-1 flex items-center gap-2 text-sm font-bold"
                style={{ color: 'var(--color-danger-fg)' }}
              >
                <TriangleAlert size={16} aria-hidden="true" />
                {jobLost ? 'Задание потеряно' : `Ошибка на этапе «${stageLabel}»`}
              </div>
              <p className="mb-1 text-sm">{jobLost ? JOB_LOST_MESSAGE : job?.error?.message}</p>
              {!jobLost && job?.error?.hint ? (
                <p className="text-sm font-semibold">Что делать: {job.error.hint}</p>
              ) : null}
            </div>
          ) : null}

          {phase === 'cancelled' ? (
            <div data-testid="ai-backlog-cancelled-summary">
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
                    Импорт прерван на этапе «{stageLabel}». До подтверждения выверки в проект ничего
                    не записывалось
                    {result && result.createdFunctions + result.createdNfrs > 0 ? (
                      <>
                        ; уже записано: <b>{result.createdFunctions} ФТ</b>,{' '}
                        <b>{result.createdNfrs} НФТ</b> — они сохранены в проекте
                      </>
                    ) : null}
                    .
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {phase === 'running' || phase === 'failed' || phase === 'cancelled' ? (
            <div>
              <div
                className="mb-1 flex items-center justify-between text-xs"
                style={{ color: 'var(--color-text-3)' }}
              >
                <span className="flex items-center gap-2" data-testid="ai-backlog-stage">
                  {phase === 'running' ? (
                    <span
                      className="spinner"
                      style={{ color: 'var(--color-primary)' }}
                      aria-hidden="true"
                    />
                  ) : null}
                  Этап: {stageLabel}
                  {batch ? (
                    <span data-testid="ai-backlog-batch">
                      · батч {batch.current} из {batch.total}
                    </span>
                  ) : null}
                </span>
                <b data-testid="ai-backlog-progress-pct">{Math.round(progress)}%</b>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full"
                style={{ background: 'var(--color-border)' }}
                role="progressbar"
                aria-valuenow={Math.round(progress)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Прогресс импорта бэклога"
                data-testid="ai-backlog-progress"
              >
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{ width: `${progress}%`, background: 'var(--color-primary)' }}
                />
              </div>
            </div>
          ) : null}

          {phase === 'running' ? (
            <section
              className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5"
              aria-label="Счётчики импорта бэклога"
              data-testid="ai-backlog-counters"
            >
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-backlog-counter-functions"
              >
                <div className="font-semibold">{result?.createdFunctions ?? 0}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  создано ФТ
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-backlog-counter-nfrs"
              >
                <div className="font-semibold">{result?.createdNfrs ?? 0}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  создано НФТ
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-backlog-counter-links"
              >
                <div className="font-semibold">{result?.links ?? 0}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  связей
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-backlog-counter-duplicates"
              >
                <div className="font-semibold">{duplicatesKnown}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  дублей пропущено
                </div>
              </div>
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid="ai-backlog-counter-tokens"
              >
                <div className="font-semibold">
                  {formatTokens((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0))}
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                  токенов
                </div>
              </div>
            </section>
          ) : null}

          {/* Events feed (mockup 02) — same live-log pattern as the docs modal. */}
          <div
            className="flex flex-1 flex-col overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--color-border)' }}
            data-testid="ai-backlog-log-panel"
          >
            <div
              className="flex shrink-0 items-center justify-between border-b px-3 py-2"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
            >
              <p className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
                События
              </p>
              <div className="flex items-center gap-3">
                {phase === 'running' ? <p className="hint">обновляется автоматически</p> : null}
                {logUrl ? (
                  <a
                    href={logUrl}
                    download
                    className="hint underline"
                    style={{ color: 'var(--color-primary)' }}
                    data-testid="ai-backlog-download-log"
                  >
                    скачать лог
                  </a>
                ) : null}
              </div>
            </div>
            <div
              ref={logRef}
              className="min-h-[170px] shrink-0 grow basis-[170px] overflow-y-auto p-2.5 font-mono text-xs leading-relaxed md:basis-[300px]"
              style={{ background: AI_IMPORT_LOG_BG, color: AI_IMPORT_LOG_TEXT }}
              data-testid="ai-backlog-log"
              role="log"
              tabIndex={0}
              aria-label="События импорта бэклога"
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

      {stopConfirmOpen ? (
        <ConfirmDialog
          testid="ai-backlog-stop-confirm"
          danger
          icon={<CircleStop className="icon-sm" aria-hidden="true" />}
          title="Остановить импорт бэклога?"
          message="Размеченные батчи сохранятся — импорт можно будет продолжить позже. В проект до подтверждения выверки ничего не записывается."
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

      {cancelReviewConfirmOpen ? (
        <ConfirmDialog
          testid="ai-backlog-cancel-review-confirm"
          danger
          icon={<CircleStop className="icon-sm" aria-hidden="true" />}
          title="Отменить импорт бэклога?"
          message={CANCEL_REVIEW_MESSAGE}
          confirmLabel="Отменить импорт"
          busyLabel="Отменяем…"
          cancelLabel="Вернуться к выверке"
          busy={cancelMut.isPending}
          onCancel={() => setCancelReviewConfirmOpen(false)}
          onConfirm={() => {
            stopJob();
            setCancelReviewConfirmOpen(false);
          }}
        />
      ) : null}

      {closeConfirmOpen ? (
        <ConfirmDialog
          testid="ai-backlog-close-confirm"
          danger
          icon={<CircleStop className="icon-sm" aria-hidden="true" />}
          title="Прекратить импорт бэклога?"
          message={CLOSE_WHILE_RUNNING_MESSAGE}
          confirmLabel="Остановить и закрыть"
          cancelLabel="Продолжить анализ"
          onCancel={() => setCloseConfirmOpen(false)}
          onConfirm={() => {
            stopJob();
            setCloseConfirmOpen(false);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}

/* ── task25 · review-cell editors ─────────────────────────────────────────── */

const EMPTY_NAME_HINT = 'Бизнес-имя не может быть пустым';

/**
 * Inline editor of the «Бизнес-имя» cell: click (or the ✎ icon) opens an
 * input right in the cell; Enter/blur saves, Esc cancels, an empty value is
 * rejected with a hint. The saved value goes to the row edits of the modal.
 */
function BusinessNameEditor({
  name,
  onSave,
}: {
  name: string;
  onSave: (name: string) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [emptyError, setEmptyError] = useState(false);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setEmptyError(true);
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-left"
        title="Изменить бизнес-имя"
        data-testid="ai-backlog-edit-name"
        onClick={() => {
          setDraft(name);
          setEmptyError(false);
          setEditing(true);
        }}
      >
        {name}
        <Pencil
          className="icon-sm shrink-0"
          style={{ color: 'var(--color-text-3)' }}
          aria-hidden="true"
        />
      </button>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <input
        className="input min-w-48 py-1 text-sm"
        aria-label="Бизнес-имя"
        aria-invalid={emptyError || undefined}
        data-testid="ai-backlog-name-input"
        autoFocus
        maxLength={200}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (emptyError) setEmptyError(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            // Esc cancels the edit only — the modal must stay open.
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      {emptyError ? (
        <span className="text-xs" role="alert" style={{ color: 'var(--color-danger-fg)' }}>
          {EMPTY_NAME_HINT}
        </span>
      ) : null}
    </span>
  );
}

/**
 * «Узел (куда встроится)» cell: the button opens a small popover with a
 * case-insensitive substring search over the EXISTING nodes of the row's type
 * (type/parent shown for orientation), a «Создать новый узел» action for a
 * custom ROOT node (v1) and «Вернуть предложенное» to drop the edit.
 */
function ParentEditor({
  parent,
  overridden,
  options,
  typeLabel,
  loading,
  onPick,
  onReset,
}: {
  parent: { kind: 'existing' | 'new'; name: string };
  overridden: boolean;
  options: NodeOption[];
  typeLabel: string;
  loading: boolean;
  onPick: (parent: { kind: 'existing' | 'new'; name: string }) => void;
  onReset: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const filtered = options.filter((o) => o.name.toLowerCase().includes(query));

  const close = (): void => {
    setOpen(false);
    setSearch('');
  };

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="inline-flex flex-wrap items-center gap-1 text-left underline decoration-dotted underline-offset-2"
        title="Изменить узел, в который встроится строка"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="ai-backlog-edit-parent"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {parent.name}
        {parent.kind === 'new' ? (
          <span
            className="badge"
            style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
            data-testid="ai-backlog-badge-new-node"
          >
            новый узел
          </span>
        ) : null}
      </button>
      {open ? (
        <>
          {/* Transparent backdrop: a click outside just closes the picker. */}
          <div className="fixed inset-0 z-10" aria-hidden="true" onClick={close} />
          <div
            className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border p-2 shadow-lg"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            role="dialog"
            aria-label="Выбор узла для строки"
            data-testid="ai-backlog-parent-popover"
          >
            <input
              className="input w-full py-1 text-sm"
              placeholder="Поиск узла или имя нового…"
              aria-label="Поиск по существующим узлам"
              data-testid="ai-backlog-parent-search"
              autoFocus
              maxLength={200}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  close();
                }
              }}
            />
            <ul
              className="mt-1 max-h-44 overflow-y-auto"
              role="listbox"
              aria-label="Существующие узлы"
            >
              {loading ? (
                <li className="hint px-2 py-1">Загружаем узлы…</li>
              ) : filtered.length === 0 ? (
                <li className="hint px-2 py-1">
                  {options.length === 0 ? `Узлов типа ${typeLabel} нет` : 'Ничего не найдено'}
                </li>
              ) : (
                filtered.map((o) => (
                  <li key={o.name}>
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-sm hover:bg-[var(--color-surface-2)]"
                      role="option"
                      aria-selected={parent.kind === 'existing' && parent.name === o.name}
                      data-testid="ai-backlog-parent-option"
                      onClick={() => {
                        onPick({ kind: 'existing', name: o.name });
                        close();
                      }}
                    >
                      {o.name}{' '}
                      <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                        {typeLabel}
                        {o.parentName ? ` · в «${o.parentName}»` : ' · корень'}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            {search.trim().length > 0 ? (
              <button
                type="button"
                className="mt-1 w-full rounded px-2 py-1 text-left text-sm font-semibold hover:bg-[var(--color-surface-2)]"
                style={{ color: 'var(--color-primary)' }}
                data-testid="ai-backlog-parent-create"
                onClick={() => {
                  onPick({ kind: 'new', name: search.trim() });
                  close();
                }}
              >
                + Создать новый узел: «{search.trim()}»
              </button>
            ) : null}
            {overridden ? (
              <button
                type="button"
                className="mt-1 w-full rounded px-2 py-1 text-left text-sm hover:bg-[var(--color-surface-2)]"
                style={{ color: 'var(--color-text-2)' }}
                data-testid="ai-backlog-parent-reset"
                onClick={() => {
                  onReset();
                  close();
                }}
              >
                Вернуть предложенное
              </button>
            ) : null}
            <p className="hint mt-1 px-2">Новый узел будет создан корневым.</p>
          </div>
        </>
      ) : null}
    </span>
  );
}

/**
 * «Срок реализации» cell: a compact Q1–Q4 select + a year input prefilled
 * with the row values. Any change becomes a per-row override; the 📄 marker
 * («срок из файла») stays until the term is overridden, then the row shows
 * the «изменено» badge instead.
 */
function TargetEditor({
  quarter,
  year,
  fromFile,
  overridden,
  onChange,
}: {
  quarter: TargetQuarter;
  year: number;
  fromFile: boolean;
  overridden: boolean;
  onChange: (quarter: TargetQuarter, year: number) => void;
}): React.ReactElement {
  return (
    <span className="flex items-center gap-1">
      <select
        className="input w-auto cursor-pointer py-0.5 text-xs"
        aria-label="Квартал срока реализации"
        data-testid="ai-backlog-target-quarter-cell"
        value={quarter}
        onChange={(e) => onChange(e.target.value as TargetQuarter, year)}
      >
        {TARGET_QUARTERS.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
      <input
        type="number"
        className="input w-16 py-0.5 text-xs"
        aria-label="Год срока реализации"
        data-testid="ai-backlog-target-year-cell"
        min={2020}
        max={2100}
        value={year}
        onChange={(e) => onChange(quarter, Number(e.target.value))}
      />
      {overridden ? (
        <span title="срок изменён вручную" style={{ color: 'var(--color-warning-fg)' }}>
          изменено
        </span>
      ) : fromFile ? (
        <span
          title="срок из файла"
          aria-label="срок из файла"
          data-testid="ai-backlog-target-from-file"
        >
          📄
        </span>
      ) : null}
    </span>
  );
}
