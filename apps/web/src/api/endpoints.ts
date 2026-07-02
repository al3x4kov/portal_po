import type { Requirement, RequirementType } from '@po/core';
import { apiDownload, apiRequest } from './client';
import type {
  CheckNameResult,
  LinkInput,
  ProjectSummary,
  RequirementCreateInput,
  RequirementListResult,
  RequirementUpdateInput,
} from './types';

export type ArchiveFormat = 'zip' | 'targz';

export const projectsApi = {
  list: (): Promise<ProjectSummary[]> => apiRequest('/projects'),
  get: (id: string): Promise<ProjectSummary> => apiRequest(`/projects/${encodeURIComponent(id)}`),
  create: (name: string): Promise<ProjectSummary> =>
    apiRequest('/projects', { method: 'POST', body: { name } }),
  import: (name: string, file: File): Promise<ProjectSummary> => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', file);
    return apiRequest('/projects/import', { method: 'POST', formData: fd });
  },
  export: (id: string, format: ArchiveFormat) =>
    apiDownload(`/projects/${encodeURIComponent(id)}/export?format=${format}`),
  /** UX-8: Excel export goes through the same fetch/blob path as the archives so
   *  errors and the busy state are handled uniformly (no bare `<a download>`). */
  exportXlsx: (id: string) => apiDownload(`/projects/${encodeURIComponent(id)}/export.xlsx`),
};

export const requirementsApi = {
  list: (projectId: string): Promise<RequirementListResult> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/requirements`),
  checkName: (
    projectId: string,
    type: RequirementType,
    name: string,
    excludeSlug?: string,
  ): Promise<CheckNameResult> => {
    const params = new URLSearchParams({ type, name });
    if (excludeSlug) params.set('excludeSlug', excludeSlug);
    return apiRequest(
      `/projects/${encodeURIComponent(projectId)}/requirements/check-name?${params.toString()}`,
    );
  },
  create: (projectId: string, input: RequirementCreateInput): Promise<Requirement> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/requirements`, {
      method: 'POST',
      body: input,
    }),
  update: (projectId: string, slug: string, input: RequirementUpdateInput): Promise<Requirement> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}`,
      {
        method: 'PUT',
        body: input,
      },
    ),
  remove: (projectId: string, slug: string): Promise<null> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}`,
      {
        method: 'DELETE',
      },
    ),
};

export const linksApi = {
  create: (projectId: string, input: LinkInput): Promise<{ ok: true }> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/links`, { method: 'POST', body: input }),
  remove: (projectId: string, input: LinkInput): Promise<{ ok: true }> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/links`, {
      method: 'DELETE',
      body: input,
    }),
};
