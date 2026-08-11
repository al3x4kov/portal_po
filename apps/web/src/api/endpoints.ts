import type {
  AiBacklogApplyBody,
  AiChatRequest,
  AiChatResponse,
  AiConfigUpdate,
  AiConfigView,
  AiDocsApplyBody,
  AiImportConfirmBody,
  AiImportJobList,
  AiImportJobView,
  AiImportStartResponse,
  AiModelsView,
  ExportOptionalField,
  GenerateDescriptionRequest,
  AiGenerateTestsRequest,
  AiGenerateTestsResponse,
  GenerateDescriptionResponse,
  ProjectDictionaries,
  Requirement,
  RequirementType,
  SourcePriority,
  SourceRef,
} from '@po/core';
import { apiDownload, apiRequest } from './client';
import type {
  AddPriorityInput,
  AddSourceInput,
  CheckNameResult,
  DeleteRequirementResult,
  LinkInput,
  MoveRequirementInput,
  MoveRequirementResult,
  ProjectSummary,
  RequirementCreateInput,
  RequirementListResult,
  RequirementUpdateInput,
  UpdatePriorityInput,
  UpdateSourceInput,
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
  /** B1 (todo_16): DELETE /api/projects/:id → 204 (empty body) on success. */
  remove: (id: string): Promise<null> =>
    apiRequest(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  /**
   * UX-2: delete a requirement. Without `cascade` a leaf/childless node answers
   * 204 (→ `null`); a node with children answers 409 HAS_CHILDREN. With
   * `cascade=true` the whole subtree is removed atomically and the server
   * answers 200 `{ deleted, slugs }`.
   */
  remove: (
    projectId: string,
    slug: string,
    cascade = false,
  ): Promise<DeleteRequirementResult | null> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}${
        cascade ? '?cascade=true' : ''
      }`,
      {
        method: 'DELETE',
      },
    ),
  /**
   * Move a row in the tree: replace its single CHILD_OF link. This is the whole
   * of «переместить строку» — sibling order is not stored, so the payload names
   * a parent, never a position.
   */
  move: (
    projectId: string,
    slug: string,
    input: MoveRequirementInput,
  ): Promise<MoveRequirementResult> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}/parent`,
      { method: 'PUT', body: input },
    ),
};

/**
 * T-803: AI Hub client (Task 8). The server never returns the API key — only
 * `hasApiKey` — so `getConfig` is safe to cache. Model selection is per-project
 * (`projectId` carries the association on save).
 */
export const aiApi = {
  /** `projectId` is optional (Task 9): without it the global view is returned
   *  (`hasApiKey`/`baseURL`, no per-project model) — used by the chat widget
   *  on screens where no project is open. */
  getConfig: (projectId?: string): Promise<AiConfigView> =>
    apiRequest(projectId ? `/ai/config?projectId=${encodeURIComponent(projectId)}` : '/ai/config'),
  saveConfig: (update: AiConfigUpdate): Promise<AiConfigView> =>
    apiRequest('/ai/config', { method: 'PUT', body: update }),
  listModels: (): Promise<AiModelsView> => apiRequest('/ai/models'),
  generateDescription: (input: GenerateDescriptionRequest): Promise<GenerateDescriptionResponse> =>
    apiRequest('/ai/generate-description', { method: 'POST', body: input }),
  /** Развилка «Генерации артефактов»: AI-кейсы для одного батча требований. */
  generateTests: (input: AiGenerateTestsRequest): Promise<AiGenerateTestsResponse> =>
    apiRequest('/ai/generate-tests', { method: 'POST', body: input }),
  /** Task 9: one chat turn — sends the trailing history, gets one assistant reply. */
  chat: (input: AiChatRequest): Promise<AiChatResponse> =>
    apiRequest('/ai/chat', { method: 'POST', body: input }),
};

/**
 * Task 11: AI-import of ФТ/НФТ from a documentation archive. `start` uploads
 * the archive as multipart (same client path as `projectsApi.import`); `model`
 * is an optional override — absent means "use the project model" (server
 * falls back and answers 400 when neither is set). `inferLinks` (todo_16 B2)
 * turns on the optional AI relate step; the field is sent as the text 'true'
 * only when enabled — absence means false, so the off-path request is
 * byte-identical to the pre-B2 one.
 */
export const aiImportApi = {
  start: (
    projectId: string,
    file: File,
    model?: string,
    inferLinks?: boolean,
    buildTree?: boolean,
  ): Promise<AiImportStartResponse> => {
    const fd = new FormData();
    if (model) fd.append('model', model);
    if (inferLinks) fd.append('inferLinks', 'true');
    // Логическое дерево «навыка AI PO»: то же правило — поле только при включении.
    if (buildTree) fd.append('buildTree', 'true');
    fd.append('file', file);
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/ai-import`, {
      method: 'POST',
      formData: fd,
    });
  },
  /**
   * todo_22 (T-305): AI-импорт бэклога из xlsx — same multipart shape as
   * `start`, kind='backlog' server-side. 409 while another import of the
   * project is unfinished (including an abandoned review gate).
   */
  startBacklog: (projectId: string, file: File, model?: string): Promise<AiImportStartResponse> => {
    const fd = new FormData();
    if (model) fd.append('model', model);
    fd.append('file', file);
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/ai-backlog-import`, {
      method: 'POST',
      formData: fd,
    });
  },
  getJob: (jobId: string): Promise<AiImportJobView> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}`),
  cancel: (jobId: string): Promise<AiImportJobView> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  /**
   * todo_20 T-204: confirm a job paused on the estimate gate (409 otherwise).
   * todo_22: backlog jobs carry the shared target in the body (both fields
   * together or none — the server falls back to `preview.defaultTarget`);
   * docs jobs keep the historical body-less call.
   */
  confirm: (jobId: string, body?: AiImportConfirmBody): Promise<AiImportJobView> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}/confirm`, {
      method: 'POST',
      ...(body ? { body } : {}),
    }),
  /**
   * todo_22 (T-306): write the reviewed selection into the project — the ONLY
   * step of the backlog flow that writes. 409 when the job is not on the
   * review gate, 400 on unknown rowIds, 422 on an empty selection.
   * task25: the body optionally carries per-row `overrides` (edited business
   * name / parent node / target term); override keys must be a subset of
   * `rowIds` — invalid edits come back as 400 with a russian message.
   */
  apply: (jobId: string, body: AiBacklogApplyBody): Promise<AiImportJobView> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}/apply`, {
      method: 'POST',
      body,
    }),
  /**
   * Двухзонная выверка docs-импорта: apply one review zone. `phase:'self'`
   * confirms zone 1 (gen-vs-gen duplicates) and opens zone 2; `phase:'existing'`
   * confirms zone 2 (gen-vs-project duplicates) and starts the actual write.
   */
  applyDocs: (jobId: string, body: AiDocsApplyBody): Promise<AiImportJobView> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}/apply`, {
      method: 'POST',
      body,
    }),
  /** todo_20 T-212: resume failed | cancelled | interrupted from the checkpoint.
   *  202 with the SAME jobId — the caller keeps polling the same view. */
  resume: (jobId: string): Promise<AiImportStartResponse> =>
    apiRequest(`/ai-import/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }),
  /** todo_20 PO №4: full run history of a project (newest first). */
  listJobs: (projectId: string): Promise<AiImportJobList> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/ai-import/jobs`),
  /** todo_20 Н4: direct download URL of the full text log (attachment). */
  logUrl: (jobId: string): string => `/api/ai-import/${encodeURIComponent(jobId)}/log`,
};

/**
 * todo_19 (T-201): per-project dictionaries — the source-priority list and the
 * auto-collected source list. All bodies/queries mirror the server Zod contract
 * (`apps/server/routes/dictionaries.ts`). Delete of a used priority requires a
 * `reassignTo` target, otherwise the server answers 409.
 */
export const dictionariesApi = {
  get: (projectId: string): Promise<ProjectDictionaries> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/dictionaries`),
  addPriority: (projectId: string, input: AddPriorityInput): Promise<SourcePriority> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/dictionaries/priorities`, {
      method: 'POST',
      body: input,
    }),
  updatePriority: (
    projectId: string,
    pid: string,
    input: UpdatePriorityInput,
  ): Promise<SourcePriority> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/dictionaries/priorities/${encodeURIComponent(pid)}`,
      { method: 'PUT', body: input },
    ),
  deletePriority: (projectId: string, pid: string, reassignTo?: string): Promise<null> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/dictionaries/priorities/${encodeURIComponent(pid)}${
        reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ''
      }`,
      { method: 'DELETE' },
    ),
  addSource: (projectId: string, input: AddSourceInput): Promise<SourceRef> =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/dictionaries/sources`, {
      method: 'POST',
      body: input,
    }),
  updateSource: (projectId: string, sid: string, input: UpdateSourceInput): Promise<SourceRef> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/dictionaries/sources/${encodeURIComponent(sid)}`,
      { method: 'PUT', body: input },
    ),
  deleteSource: (projectId: string, sid: string): Promise<null> =>
    apiRequest(
      `/projects/${encodeURIComponent(projectId)}/dictionaries/sources/${encodeURIComponent(sid)}`,
      { method: 'DELETE' },
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
