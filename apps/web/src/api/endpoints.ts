import type { ExportOptionalField, Requirement, RequirementType } from '@po/core';
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

/**
 * T-203: serialize the optional-fields selection into a query parameter.
 * The contract (`@po/core`) is: `fields` absent ⇒ all optional fields; empty
 * ⇒ none (minimum). We therefore build the parameter *explicitly* from the
 * caller's selection — `undefined` omits it entirely (lossless default), an
 * array (including `[]`) always emits `fields=...` so the server honours the
 * exact choice instead of falling back to "all".
 */
function fieldsQuery(sep: '?' | '&', fields?: ExportOptionalField[]): string {
  if (fields === undefined) return '';
  return `${sep}fields=${fields.join(',')}`;
}

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
  export: (id: string, format: ArchiveFormat, fields?: ExportOptionalField[]) =>
    apiDownload(
      `/projects/${encodeURIComponent(id)}/export?format=${format}${fieldsQuery('&', fields)}`,
    ),
  /** T-523: Selective archive export via POST /api/projects/:id/export/selected.
   *  Returns the same { blob, filename } shape as apiDownload.
   *  T-203: carries the optional-fields selection in the body. */
  exportSelected: async (
    id: string,
    format: 'xlsx' | ArchiveFormat,
    slugs: string[],
    fields?: ExportOptionalField[],
  ): Promise<{ blob: Blob; filename: string }> => {
    const body: {
      format: 'xlsx' | ArchiveFormat;
      slugs: string[];
      fields?: ExportOptionalField[];
    } = {
      format,
      slugs,
    };
    if (fields !== undefined) body.fields = fields;
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/export/selected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Export failed: ${text}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const ext = format === 'xlsx' ? 'xlsx' : format === 'zip' ? 'zip' : 'tar.gz';
    const filename = match ? match[1] : `${id}-partial.${ext}`;
    return { blob, filename };
  },
  /** UX-8: Excel export goes through the same fetch/blob path as the archives so
   *  errors and the busy state are handled uniformly (no bare `<a download>`). */
  exportXlsx: (id: string, fields?: ExportOptionalField[]) =>
    apiDownload(`/projects/${encodeURIComponent(id)}/export.xlsx${fieldsQuery('?', fields)}`),
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
