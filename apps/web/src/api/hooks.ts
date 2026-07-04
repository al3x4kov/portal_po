import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AiChatRequest,
  AiChatResponse,
  AiConfigUpdate,
  AiConfigView,
  AiModelsView,
  GenerateDescriptionRequest,
  GenerateDescriptionResponse,
  Requirement,
} from '@po/core';
import { useToast } from '../components/Toast';
import { aiApi, linksApi, projectsApi, requirementsApi } from './endpoints';
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

/** Saves the AI config (key/baseURL global, model per-project). Invalidates the
 *  cached config so `hasApiKey` / model status refresh immediately. */
export function useSaveAiConfig(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<AiConfigView, Error, AiConfigUpdate>({
    mutationFn: (update) => aiApi.saveConfig(update),
    onSuccess: () => {
      if (projectId) void qc.invalidateQueries({ queryKey: queryKeys.aiConfig(projectId) });
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
