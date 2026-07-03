import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the client layer so we assert the URL/params/body each endpoint builds.
vi.mock('./client', () => ({
  apiRequest: vi.fn(() => Promise.resolve({ mocked: true })),
  apiDownload: vi.fn(() => Promise.resolve({ blob: new Blob(), filename: 'file' })),
}));

import { apiDownload, apiRequest } from './client';
import { projectsApi, requirementsApi, linksApi } from './endpoints';

const apiRequestMock = vi.mocked(apiRequest);
const apiDownloadMock = vi.mocked(apiDownload);

beforeEach(() => {
  apiRequestMock.mockClear();
  apiDownloadMock.mockClear();
});

describe('projectsApi', () => {
  it('list → GET /projects', async () => {
    await projectsApi.list();
    expect(apiRequestMock).toHaveBeenCalledWith('/projects');
  });

  it('get → GET /projects/:id with encoded id', async () => {
    await projectsApi.get('a b/c');
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/a%20b%2Fc');
  });

  it('create → POST /projects with { name } body', async () => {
    await projectsApi.create('My Project');
    expect(apiRequestMock).toHaveBeenCalledWith('/projects', {
      method: 'POST',
      body: { name: 'My Project' },
    });
  });

  it('import → POST /projects/import with FormData carrying name + file', async () => {
    const file = new File(['x'], 'a.zip');
    await projectsApi.import('Imported', file);
    const [path, opts] = apiRequestMock.mock.calls[0];
    expect(path).toBe('/projects/import');
    expect(opts?.method).toBe('POST');
    const fd = opts?.formData as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('name')).toBe('Imported');
    expect(fd.get('file')).toBe(file);
  });

  it('export → apiDownload with format query param', async () => {
    await projectsApi.export('proj id', 'zip');
    expect(apiDownloadMock).toHaveBeenCalledWith('/projects/proj%20id/export?format=zip');
  });

  it('export supports targz format', async () => {
    await projectsApi.export('p', 'targz');
    expect(apiDownloadMock).toHaveBeenCalledWith('/projects/p/export?format=targz');
  });

  it('exportXlsx → apiDownload of the .xlsx path', async () => {
    await projectsApi.exportXlsx('p');
    expect(apiDownloadMock).toHaveBeenCalledWith('/projects/p/export.xlsx');
  });
});

describe('projectsApi.exportSelected (raw fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(res: Partial<Response>) {
    const fn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(res as Response),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('POSTs { format, slugs } and returns blob + filename from header', async () => {
    const fetchMock = mockFetch({
      ok: true,
      blob: () => Promise.resolve(new Blob(['z'])),
      headers: new Headers({ 'content-disposition': 'attachment; filename="part.zip"' }),
    } as Partial<Response>);
    const { blob, filename } = await projectsApi.exportSelected('proj id', 'zip', ['a', 'b']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/proj%20id/export/selected');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ format: 'zip', slugs: ['a', 'b'] }));
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('part.zip');
  });

  it('falls back to "<id>-partial.zip" when no content-disposition (zip)', async () => {
    mockFetch({
      ok: true,
      blob: () => Promise.resolve(new Blob()),
      headers: new Headers(),
    } as Partial<Response>);
    const { filename } = await projectsApi.exportSelected('p', 'zip', ['a']);
    expect(filename).toBe('p-partial.zip');
  });

  it('falls back to "<id>-partial.tar.gz" for targz', async () => {
    mockFetch({
      ok: true,
      blob: () => Promise.resolve(new Blob()),
      headers: new Headers(),
    } as Partial<Response>);
    const { filename } = await projectsApi.exportSelected('p', 'targz', ['a']);
    expect(filename).toBe('p-partial.tar.gz');
  });

  it('throws with the response text when the export fails', async () => {
    mockFetch({
      ok: false,
      text: () => Promise.resolve('boom'),
    } as Partial<Response>);
    await expect(projectsApi.exportSelected('p', 'zip', ['a'])).rejects.toThrow(
      'Export failed: boom',
    );
  });
});

describe('requirementsApi', () => {
  it('list → GET /projects/:id/requirements', async () => {
    await requirementsApi.list('p id');
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p%20id/requirements');
  });

  it('checkName → GET check-name with type & name params', async () => {
    await requirementsApi.checkName('p', 'FUNCTION', 'Оплата картой');
    const [path] = apiRequestMock.mock.calls[0];
    const url = new URL(path as string, 'http://x');
    expect(url.pathname).toBe('/projects/p/requirements/check-name');
    expect(url.searchParams.get('type')).toBe('FUNCTION');
    expect(url.searchParams.get('name')).toBe('Оплата картой');
    expect(url.searchParams.has('excludeSlug')).toBe(false);
  });

  it('checkName includes excludeSlug when provided', async () => {
    await requirementsApi.checkName('p', 'NFR', 'x', 'my-slug');
    const [path] = apiRequestMock.mock.calls[0];
    const url = new URL(path as string, 'http://x');
    expect(url.searchParams.get('excludeSlug')).toBe('my-slug');
  });

  it('create → POST requirements with the input body', async () => {
    const input = {
      type: 'FUNCTION' as const,
      name: 'X',
      criticality: 'HIGH' as const,
      implemented: true,
    };
    await requirementsApi.create('p', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p/requirements', {
      method: 'POST',
      body: input,
    });
  });

  it('update → PUT requirements/:slug with the input body (both encoded)', async () => {
    const input = { name: 'X', criticality: 'LOW' as const, implemented: false };
    await requirementsApi.update('p id', 'a/b', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p%20id/requirements/a%2Fb', {
      method: 'PUT',
      body: input,
    });
  });

  it('remove → DELETE requirements/:slug', async () => {
    await requirementsApi.remove('p', 's/lug');
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p/requirements/s%2Flug', {
      method: 'DELETE',
    });
  });
});

describe('linksApi', () => {
  const input = { sourceSlug: 'a', type: 'CHILD_OF' as const, targetSlug: 'b' };

  it('create → POST /projects/:id/links with the link body', async () => {
    await linksApi.create('p id', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p%20id/links', {
      method: 'POST',
      body: input,
    });
  });

  it('remove → DELETE /projects/:id/links with the link body', async () => {
    await linksApi.remove('p', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/projects/p/links', {
      method: 'DELETE',
      body: input,
    });
  });
});
