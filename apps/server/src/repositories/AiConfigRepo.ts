import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AI_DEFAULT_BASE_URL,
  aiModelPresetOverrideSchema,
  aiRequestDelaySecSchema,
  type AiConfigUpdate,
  type AiConfigView,
  type AiModelPresetOverride,
} from '@po/core';
import { atomicWrite } from '../lib/atomicWrite.js';

/** On-disk shape of `<PROJECTS_ROOT>/.ai-config.json` (plaintext, gitignored). */
export interface AiConfigFile {
  baseURL: string;
  /** Personal API key, plaintext. Absent when never configured. NEVER logged/returned. */
  apiKey?: string;
  /** Per-project selected model, keyed by projectId (kept out of Projects/<id>/). */
  modelByProject: Record<string, string>;
  /**
   * Per-model best-practice OVERRIDES, keyed by model id (todo_18). Only the
   * fields the user changed are stored — defaults are never materialised. Absent
   * when nothing is overridden; the effective preset is computed via
   * `resolveModelPreset(model, modelPresets[model])`.
   */
  modelPresets?: Record<string, AiModelPresetOverride>;
  /**
   * «Задержка при отправке запросов в секундах»: принудительная пауза после
   * КАЖДОГО запроса к AI Hub (троттлинг перегруженного хаба — разбор NET-02).
   * Absent = 0 = выключена; дефолт не материализуется на диске.
   */
  requestDelaySec?: number;
}

/** Keep only valid, non-empty per-model overrides (defensive against hand edits). */
function sanitizePresets(input: unknown): Record<string, AiModelPresetOverride> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, AiModelPresetOverride> = {};
  for (const [model, raw] of Object.entries(input as Record<string, unknown>)) {
    const parsed = aiModelPresetOverrideSchema.safeParse(raw);
    if (parsed.success && Object.keys(parsed.data).length > 0) out[model] = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Fixed filename for the global AI config, resolved against the projects root. */
export const AI_CONFIG_FILENAME = '.ai-config.json';

/**
 * Repository for the single global AI Hub config file. Reads tolerate a missing
 * file (defaults), writes are atomic (temp + rename). The API key is stored on
 * disk but the {@link getView} projection never exposes it — only `hasApiKey`.
 */
export class AiConfigRepo {
  private readonly file: string;

  constructor(projectsRoot: string) {
    this.file = path.join(projectsRoot, AI_CONFIG_FILENAME);
  }

  /** Read the config, returning safe defaults when the file is absent/blank. */
  async read(): Promise<AiConfigFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return { baseURL: AI_DEFAULT_BASE_URL, modelByProject: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { baseURL: AI_DEFAULT_BASE_URL, modelByProject: {} };
    }
    const obj = (parsed ?? {}) as Partial<AiConfigFile>;
    const presets = sanitizePresets(obj.modelPresets);
    // Defensive against hand edits: an invalid/zero delay reads as «выключена».
    const delayParsed = aiRequestDelaySecSchema.safeParse(obj.requestDelaySec);
    const requestDelaySec =
      delayParsed.success && delayParsed.data > 0 ? delayParsed.data : undefined;
    return {
      baseURL: typeof obj.baseURL === 'string' && obj.baseURL ? obj.baseURL : AI_DEFAULT_BASE_URL,
      apiKey: typeof obj.apiKey === 'string' && obj.apiKey.length > 0 ? obj.apiKey : undefined,
      modelByProject:
        obj.modelByProject && typeof obj.modelByProject === 'object' ? obj.modelByProject : {},
      ...(presets ? { modelPresets: presets } : {}),
      ...(requestDelaySec !== undefined ? { requestDelaySec } : {}),
    };
  }

  /**
   * Safe projection for `GET /api/ai/config`: baseURL, whether a key is stored,
   * and the model selected for `projectId`. NEVER includes the key itself.
   */
  async getView(projectId?: string): Promise<AiConfigView> {
    const cfg = await this.read();
    const model = projectId ? cfg.modelByProject[projectId] : undefined;
    return {
      baseURL: cfg.baseURL,
      hasApiKey: Boolean(cfg.apiKey),
      ...(model ? { model } : {}),
      ...(cfg.modelPresets ? { modelPresets: cfg.modelPresets } : {}),
      ...(cfg.requestDelaySec !== undefined ? { requestDelaySec: cfg.requestDelaySec } : {}),
    };
  }

  /**
   * Apply a partial update and persist atomically. `apiKey` is written only when
   * passed non-empty (blank/omitted keep the existing key); an explicit `null`
   * deletes the stored key while leaving `modelByProject` untouched (Task 10).
   * `model` is stored under `modelByProject[projectId]` (requires `projectId`).
   * Returns the safe view.
   */
  async update(patch: AiConfigUpdate): Promise<AiConfigView> {
    const cfg = await this.read();

    if (patch.baseURL) cfg.baseURL = patch.baseURL;
    if (patch.apiKey === null) delete cfg.apiKey;
    else if (patch.apiKey && patch.apiKey.trim().length > 0) cfg.apiKey = patch.apiKey;
    if (patch.projectId && patch.model) cfg.modelByProject[patch.projectId] = patch.model;
    // «Задержка при отправке запросов»: 0 выключает (ключ удаляется с диска).
    if (patch.requestDelaySec !== undefined) {
      if (patch.requestDelaySec > 0) cfg.requestDelaySec = patch.requestDelaySec;
      else delete cfg.requestDelaySec;
    }

    // Merge per-model preset overrides (todo_18): a non-empty override object is
    // stored, an empty `{}` resets that model to its defaults (drops the key so
    // defaults are never materialised on disk).
    if (patch.modelPresets) {
      const merged: Record<string, AiModelPresetOverride> = { ...(cfg.modelPresets ?? {}) };
      for (const [model, override] of Object.entries(patch.modelPresets)) {
        const parsed = aiModelPresetOverrideSchema.parse(override);
        const defined: AiModelPresetOverride = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (v !== undefined) (defined as Record<string, unknown>)[k] = v;
        }
        if (Object.keys(defined).length === 0) delete merged[model];
        else merged[model] = defined;
      }
      if (Object.keys(merged).length > 0) cfg.modelPresets = merged;
      else delete cfg.modelPresets;
    }

    await atomicWrite(this.file, JSON.stringify(cfg, null, 2));
    return this.getView(patch.projectId);
  }
}
