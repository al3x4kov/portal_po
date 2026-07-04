import { useEffect } from 'react';
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
import { aiApi, aiImportApi, linksApi, projectsApi, requirementsApi } from './endpoints';
import type {
  LinkInput,
  ProjectSummary,
  RequirementCreateInput,
  RequirementListResult,
  RequirementUpdateInput,
} from './types';

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
      toast.show('Требование обновлено');
    },
  });
}

export function useDeleteRequirement(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<null, Error, string>({
    mutationFn: (rid) => requirementsApi.remove(projectId, rid),
    onSuccess: () => {
      invalidateRequirements(qc, projectId);
      toast.show('Требование удалено');
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

export function useListAiModels() {
  return useMutation<AiModelsView, Error, void>({
    mutationFn: () => aiApi.listModels(),
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

/** Starts an AI-import job: uploads the archive, gets back `{ jobId }`. */
export function useStartAiImport(projectId: string) {
  return useMutation<AiImportStartResponse, Error, { file: File; model?: string }>({
    mutationFn: ({ file, model }) => aiImportApi.start(projectId, file, model),
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
