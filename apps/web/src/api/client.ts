import type { ApiErrorBody } from './types';

/**
 * Error thrown for any non-2xx API response. Carries the server's stable
 * machine `code` and structured `details` (e.g. CycleError path, HasChildren).
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code || 'UNKNOWN';
    this.details = body.details;
  }
}

const BASE = '/api';

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toErrorBody(body: unknown, status: number): ApiErrorBody {
  if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
    return body as ApiErrorBody;
  }
  return { code: 'UNKNOWN', message: `Request failed (${status})` };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw multipart/binary body (FormData); skips JSON serialization. */
  formData?: FormData;
  signal?: AbortSignal;
}

/** Typed fetch wrapper with unified { code, message, details } error handling. */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;

  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
  });

  const parsed = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, toErrorBody(parsed, res.status));
  }
  return parsed as T;
}

/** GET that returns a Blob (for archive export download). */
export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const parsed = await parseBody(res);
    throw new ApiError(res.status, toErrorBody(parsed, res.status));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : 'export';
  return { blob, filename };
}

/** Human-readable message for any thrown value (ApiError or generic). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}
