import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, apiRequest, apiDownload, errorMessage } from './client';

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(status: number, body: unknown, ok = status < 400): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    blob: () => Promise.resolve(new Blob()),
    headers: new Headers(),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ApiError', () => {
  it('carries status, code and details from the body', () => {
    const err = new ApiError(409, {
      code: 'CYCLE',
      message: 'Цикл обнаружен',
      details: { path: ['a', 'b'] },
    });
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CYCLE');
    expect(err.message).toBe('Цикл обнаружен');
    expect(err.details).toEqual({ path: ['a', 'b'] });
    expect(err).toBeInstanceOf(Error);
  });

  it('falls back to a synthetic message when body.message is empty', () => {
    const err = new ApiError(500, { code: '', message: '' });
    expect(err.message).toBe('Request failed (500)');
    expect(err.code).toBe('UNKNOWN');
  });
});

describe('apiRequest — request building', () => {
  it('prefixes /api, defaults to GET and sends no body/content-type', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, { ok: true }));
    const result = await apiRequest<{ ok: boolean }>('/projects');
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({});
  });

  it('serializes a JSON body and sets content-type for POST', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, { id: '1' }));
    await apiRequest('/projects', { method: 'POST', body: { name: 'x' } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'x' }));
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('sends FormData without JSON serialization or content-type', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, {}));
    const fd = new FormData();
    fd.append('name', 'x');
    await apiRequest('/projects/import', { method: 'POST', formData: fd });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBe(fd);
    expect(init?.headers).toEqual({});
  });

  it('passes through the abort signal', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, {}));
    const controller = new AbortController();
    await apiRequest('/x', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });
});

describe('apiRequest — response parsing', () => {
  it('returns null for a 204 No Content response without reading the body', async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 204,
          text: () => Promise.reject(new Error('should not be called')),
          headers: new Headers(),
        }) as unknown as Response,
    );
    await expect(apiRequest('/x', { method: 'DELETE' })).resolves.toBeNull();
  });

  it('returns null for an empty (but 200) body', async () => {
    mockFetch(() => jsonResponse(200, ''));
    await expect(apiRequest('/x')).resolves.toBeNull();
  });

  it('returns the raw text when the body is not valid JSON', async () => {
    mockFetch(() => jsonResponse(200, 'plain text', true));
    await expect(apiRequest<string>('/x')).resolves.toBe('plain text');
  });
});

describe('apiRequest — error branches', () => {
  it('throws ApiError with the parsed { code, message } envelope on HTTP error', async () => {
    mockFetch(() => jsonResponse(409, { code: 'HAS_CHILDREN', message: 'Есть дочерние' }, false));
    await expect(apiRequest('/x')).rejects.toMatchObject({
      status: 409,
      code: 'HAS_CHILDREN',
      message: 'Есть дочерние',
    });
  });

  it('synthesizes an UNKNOWN error body when the error payload is non-JSON', async () => {
    mockFetch(() => jsonResponse(500, '<html>Boom</html>', false));
    try {
      await apiRequest('/x');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe('UNKNOWN');
      expect(e.status).toBe(500);
      expect(e.message).toBe('Request failed (500)');
    }
  });

  it('synthesizes UNKNOWN when the JSON body lacks code/message keys', async () => {
    mockFetch(() => jsonResponse(400, { something: 'else' }, false));
    await expect(apiRequest('/x')).rejects.toMatchObject({ code: 'UNKNOWN', status: 400 });
  });

  it('propagates a network failure (fetch rejects)', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiRequest('/x')).rejects.toThrow('Failed to fetch');
  });
});

describe('apiDownload', () => {
  it('returns the blob and parses the filename from content-disposition', async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(['data'])),
          headers: new Headers({
            'content-disposition': 'attachment; filename="project.zip"',
          }),
        }) as unknown as Response,
    );
    const { blob, filename } = await apiDownload('/projects/p/export?format=zip');
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('project.zip');
  });

  it('falls back to "export" when there is no content-disposition header', async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob()),
          headers: new Headers(),
        }) as unknown as Response,
    );
    const { filename } = await apiDownload('/x');
    expect(filename).toBe('export');
  });

  it('throws ApiError when the download response is not ok', async () => {
    mockFetch(() => jsonResponse(404, { code: 'NOT_FOUND', message: 'Нет проекта' }, false));
    await expect(apiDownload('/x')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('errorMessage', () => {
  it('returns the message of an ApiError', () => {
    expect(errorMessage(new ApiError(400, { code: 'X', message: 'Плохой запрос' }))).toBe(
      'Плохой запрос',
    );
  });

  it('returns the message of a generic Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a Russian fallback for non-Error values', () => {
    expect(errorMessage('string thrown')).toBe('Неизвестная ошибка');
    expect(errorMessage(null)).toBe('Неизвестная ошибка');
    expect(errorMessage(undefined)).toBe('Неизвестная ошибка');
    expect(errorMessage({ weird: true })).toBe('Неизвестная ошибка');
  });
});
