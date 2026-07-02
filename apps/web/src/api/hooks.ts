import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Requirement } from '@po/core';
import { useToast } from '../components/Toast';
import { linksApi, projectsApi, requirementsApi } from './endpoints';
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
