import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AiChatRequest,
  AiChatResponse,
  AiConfigUpdate,
  AiConfigView,
  AiImportJobView,
  AiImportStartResponse,
  AiModelsView,
  GenerateDescriptionRequest,
  GenerateDescriptionResponse,
  Requirement,
} from '@po/core';
import { useToast } from '../components/Toast';
import { useUiStore } from '../store/ui';
import { errorMessage } from './client';
import { aiApi, aiImportApi, linksApi, projectsApi, requirementsApi } from './endpoints';
import type {
  DeleteRequirementResult,
  LinkInput,
  ProjectSummary,
  RequirementCreateInput,
  RequirementListResult,
  RequirementUpdateInput,
} from './types';
import { requirementsLabel } from '../lib/plural';

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  requirements: (projectId: string) => ['projects', projectId, 'requirements'] as const,
  /** Prefix matching every cached AI config (any project + the global '' key). */
  aiConfigAll: ['ai', 'config'] as const,
  aiConfig: (projectId: string) => ['ai', 'config', projectId] as const,
  aiModels: ['ai', 'models'] as const,
  aiImportJob: (jobId: string) => ['ai-import', jobId] as const,
};

export function useProjects(): UseQueryResult<ProjectSummary[]> {
  return useQuery({ queryKey: queryKeys.projects, queryFn: projectsApi.list });
}

export function useProject(id: string | undefined): UseQueryResult<ProjectSummary> {
  return useQuery({
    queryKey: queryKeys.project(id ?? ''),
    queryFn: () => projectsApi.get(id as string),
    enabled: Boolean(id),
  });
}

export function useRequirements(
  projectId: string | undefined,
): UseQueryResult<RequirementListResult> {
  return useQuery({
    queryKey: queryKeys.requirements(projectId ?? ''),
    queryFn: () => requirementsApi.list(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => projectsApi.create(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useImportProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => projectsApi.import(name, file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/**
 * B1 (todo_16): deletes a project (and its whole directory on disk) via
 * DELETE /api/projects/:id. On success the projects list is invalidated,
 * every cached query scoped to the deleted project is dropped, and the
 * project-scoped UI selection (expanded branches, search, filters, open
 * modal) is reset — the app has no other "selected project" state besides
 * the route, so this is the full cleanup. Success feedback via toast; errors
 * are NOT toasted here — the caller shows them inside the confirm dialog
 * (§2.4-4, todo_17 T2) so the failure is never swallowed by a vanishing toast.
 */
export function useDeleteProject() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<null, Error, { id: string; name: string }>({
    mutationFn: ({ id }) => projectsApi.remove(id),
    onSuccess: (_data, { id, name }) => {
      // Drop project-scoped caches first so the list invalidation below does
      // not refetch queries for a project that no longer exists.
      qc.removeQueries({ queryKey: queryKeys.project(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.projects, exact: true });
      const ui = useUiStore.getState();
      ui.closeModal();
      ui.setExpanded([]);
      ui.setSearch('');
      ui.resetFilters();
      toast.show(`Проект «${name}» удалён`);
    },
  });
}

function invalidateRequirements(qc: ReturnType<typeof useQueryClient>, projectId: string): void {
  void qc.invalidateQueries({ queryKey: queryKeys.requirements(projectId) });
}

export function useCreateRequirement(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Requirement, Error, RequirementCreateInput>({
    mutationFn: (input) => requirementsApi.create(projectId, input),
    onSuccess: () => {
      invalidateRequirements(qc, projectId);
      toast.show('Требование создано');
    },
  });
}

export function useUpdateRequirement(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Requirement, Error, { slug: string; input: RequirementUpdateInput }>({
    mutationFn: ({ slug, input }) => requirementsApi.update(projectId, slug, input),
    onSuccess: () => {
      invalidateRequirements(qc, projectId);
      // Уровень 0 (§2.10-2): сохранение без confirm — подтверждение через toast.
      toast.show('Сохранено');
    },
  });
}

/**
 * UX-2: delete a requirement, optionally cascading over its subtree. The leaf
 * path (204 → `null`) removes exactly one; the cascade path returns the true
 * `deleted` count from the server, which the toast echoes verbatim.
 */
export function useDeleteRequirement(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<DeleteRequirementResult | null, Error, { slug: string; cascade?: boolean }>({
    mutationFn: ({ slug, cascade }) => requirementsApi.remove(projectId, slug, cascade),
    onSuccess: (result) => {
      invalidateRequirements(qc, projectId);
      const deleted = result?.deleted ?? 1;
      toast.show(`Удалено ${requirementsLabel(deleted)}`);
    },
  });
}

/* ── AI Hub (Task 8, T-803) ──────────────────────────────────────────────── */

/**
 * AI Hub config view. With `projectId` includes the per-project model; without
 * it (Task 9 chat widget on screens with no open project) returns the global
 * view — `hasApiKey`/`baseURL` only.
 */
export function useAiConfig(projectId: string | undefined): UseQueryResult<AiConfigView> {
  return useQuery({
    queryKey: queryKeys.aiConfig(projectId ?? ''),
    queryFn: () => aiApi.getConfig(projectId),
  });
}

/** Saves the AI config (key/baseURL global, model per-project). The API key and
 *  baseURL are GLOBAL, so invalidate every cached config view (`aiConfigAll`
 *  prefix covers the global `''` key and every per-project key) — otherwise the
 *  chat widget / other projects keep a stale `hasApiKey` until a reload. */
export function useSaveAiConfig() {
  const qc = useQueryClient();
  return useMutation<AiConfigView, Error, AiConfigUpdate>({
    mutationFn: (update) => aiApi.saveConfig(update),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.aiConfigAll });
    },
  });
}

/**
 * Deletes the stored AI Hub API key: `PUT /api/ai/config` with `{ apiKey: null }`
 * (Task 10). `''`/`undefined` keep the key untouched (Task 8 semantics), so `null`
 * is the only "forget the key" signal. Per-project models are preserved server-side.
 * Invalidates every cached config (the key is global) so the AI page returns to its
 * empty state and the chat widget greys out immediately.
 */
export function useDeleteAiKey() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<AiConfigView, Error, void>({
    mutationFn: () => aiApi.saveConfig({ apiKey: null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.aiConfigAll });
      toast.show('API-ключ удалён');
    },
  });
}

/* ── AI chat widget (Task 9) ─────────────────────────────────────────────── */

/**
 * Cached model list for the chat dropdown. Like the AiPage flow, models are
 * requested only once a key is stored (`enabled` = hasApiKey && widget open).
 */
export function useAiModels(enabled: boolean): UseQueryResult<AiModelsView> {
  return useQuery({
    queryKey: queryKeys.aiModels,
    queryFn: () => aiApi.listModels(),
    enabled,
  });
}

/* ── AI model list refresh + selection reconciliation (todo_16 A3) ───────── */

/** Human-readable inline message shown next to the model select. */
export interface AiModelsNotice {
  kind: 'reset' | 'error';
  text: string;
}

export type AiModelsRefreshResult = { ok: true; models: string[] } | { ok: false; error: Error };

export interface UseAiModelsRefreshOptions {
  /** Auto-fetch the list (React Query `enabled`). `refresh()` works regardless. */
  enabled: boolean;
  /** Currently selected model id ('' when nothing is selected). */
  selectedModel: string;
  /** Preferred replacement when the selected model vanished (e.g. project model). */
  fallbackModel?: string;
  /** Applies the replacement when the selected model vanished after a refresh. */
  onModelReset: (model: string) => void;
}

export interface UseAiModelsRefreshResult {
  /** Latest loaded model list (shared `aiModels` cache). */
  models: string[];
  isFetching: boolean;
  /** Set after `refresh()`: selection reset ('reset') or request failure ('error'). */
  notice: AiModelsNotice | null;
  clearNotice: () => void;
  /** Re-requests the list and reconciles the current selection. Never throws. */
  refresh: () => Promise<AiModelsRefreshResult>;
}

/**
 * A3 (todo_16): shared «Обновить список моделей» logic for the AI screen, the
 * chat widget and the AI-import modal. Wraps the cached `useAiModels` query;
 * `refresh()` refetches (works even when `enabled` is false) and, if the
 * selected model vanished from the fresh list, picks `fallbackModel` (when
 * still available) or the first model and reports it via `notice` so the UI
 * can show an unobtrusive inline message.
 */
export function useAiModelsRefresh(opts: UseAiModelsRefreshOptions): UseAiModelsRefreshResult {
  const query = useAiModels(opts.enabled);
  const { refetch } = query;
  const [notice, setNotice] = useState<AiModelsNotice | null>(null);
  // refresh() must see the CURRENT selection, not the one captured on render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const refresh = useCallback(async (): Promise<AiModelsRefreshResult> => {
    setNotice(null);
    const res = await refetch();
    if (res.error || res.data === undefined) {
      const error =
        res.error instanceof Error ? res.error : new Error('Пустой ответ списка моделей');
      setNotice({
        kind: 'error',
        text: `Не удалось обновить список моделей: ${errorMessage(error)}`,
      });
      return { ok: false, error };
    }
    const models = res.data.models;
    const { selectedModel, fallbackModel, onModelReset } = optsRef.current;
    if (selectedModel && !models.includes(selectedModel)) {
      const fallback =
        fallbackModel && models.includes(fallbackModel) ? fallbackModel : (models[0] ?? '');
      onModelReset(fallback);
      setNotice({
        kind: 'reset',
        text: fallback
          ? `Модель «${selectedModel}» больше недоступна — выбрана «${fallback}»`
          : `Модель «${selectedModel}» больше недоступна — выберите модель из списка`,
      });
    }
    return { ok: true, models };
  }, [refetch]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    models: query.data?.models ?? [],
    isFetching: query.isFetching,
    notice,
    clearNotice,
    refresh,
  };
}

/** One chat turn: POST /api/ai/chat with the trailing message history. */
export function useAiChat() {
  return useMutation<AiChatResponse, Error, AiChatRequest>({
    mutationFn: (input) => aiApi.chat(input),
  });
}

export function useGenerateDescription() {
  return useMutation<GenerateDescriptionResponse, Error, GenerateDescriptionRequest>({
    mutationFn: (input) => aiApi.generateDescription(input),
  });
}

/* ── AI import of ФТ/НФТ from documentation (Task 11) ────────────────────── */

/** Polling cadence for a running AI-import job (PO decision §3.3). */
export const AI_IMPORT_POLL_MS = 800;

/**
 * Starts an AI-import job: uploads the archive, gets back `{ jobId }`.
 * `inferLinks` (todo_16 B2) opts into the AI relate step; when falsy the call
 * keeps the exact pre-B2 shape so the off-path behaviour stays byte-identical.
 */
export function useStartAiImport(projectId: string) {
  return useMutation<
    AiImportStartResponse,
    Error,
    { file: File; model?: string; inferLinks?: boolean }
  >({
    mutationFn: ({ file, model, inferLinks }) =>
      inferLinks
        ? aiImportApi.start(projectId, file, model, true)
        : aiImportApi.start(projectId, file, model),
  });
}

/**
 * Polls `GET /api/ai-import/:jobId` every ~800 ms while the job is running.
 * When the job finishes with `succeeded` or `cancelled`, the project's
 * requirements query is invalidated — created items must appear in the tree
 * without a manual refresh (spec §3.6).
 */
export function useAiImportJob(
  projectId: string,
  jobId: string | null,
): UseQueryResult<AiImportJobView> {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.aiImportJob(jobId ?? ''),
    queryFn: () => aiImportApi.getJob(jobId as string),
    enabled: Boolean(jobId),
    // PO-T2: stop polling once the request errors (e.g. 404 after a server
    // restart lost the in-memory job) — otherwise the modal would poll forever.
    refetchInterval: (q) =>
      q.state.error == null && (q.state.data === undefined || q.state.data.status === 'running')
        ? AI_IMPORT_POLL_MS
        : false,
  });
  const status = query.data?.status;
  useEffect(() => {
    if (status === 'succeeded' || status === 'cancelled') {
      invalidateRequirements(qc, projectId);
    }
  }, [status, projectId, qc]);
  return query;
}

/** Cancels a job (idempotent); the fresh view lands in the cache right away. */
export function useCancelAiImport() {
  const qc = useQueryClient();
  return useMutation<AiImportJobView, Error, string>({
    mutationFn: (jobId) => aiImportApi.cancel(jobId),
    onSuccess: (job) => qc.setQueryData(queryKeys.aiImportJob(job.jobId), job),
  });
}

export function useCreateLink(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<{ ok: true }, Error, LinkInput>({
    mutationFn: (input) => linksApi.create(projectId, input),
    onSuccess: () => {
      invalidateRequirements(qc, projectId);
      toast.show('Связь создана');
    },
  });
}

export function useDeleteLink(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<{ ok: true }, Error, LinkInput>({
    mutationFn: (input) => linksApi.remove(projectId, input),
    onSuccess: () => {
      invalidateRequirements(qc, projectId);
      toast.show('Связь удалена');
    },
  });
}
