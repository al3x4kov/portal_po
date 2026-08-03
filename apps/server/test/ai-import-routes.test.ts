import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiImportJobView } from '@po/core';
import { buildApp } from '../src/app.js';
import type { AiClient } from '../src/services/AiHubService.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-import-secret';
const PROJECT = 'Demo';

/** Build a multipart/form-data payload for inject (as app.test.ts). */
function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----po${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  chunks.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Zip buffer from a name→content map (built with adm-zip, as production). */
function zipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Пользователь входит по email и паролю.',
    source: 'auth.md § Вход',
  },
  {
    type: 'NFR',
    name: 'Время отклика',
    description: 'Отклик до 200 мс.',
    source: 'auth.md § SLA',
  },
]);

describe('T11 AI import routes (integration, mock client)', () => {
  let root: string;
  let app: FastifyInstance;
  let client: AiClient;

  function okClient(content = EXTRACTION): AiClient {
    return {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => ({ choices: [{ message: { content } }] })),
        },
      },
    };
  }

  async function boot(c: AiClient): Promise<void> {
    client = c;
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      makeAiClient: () => c,
    });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: PROJECT } });
  }

  async function configure(): Promise<void> {
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: PROJECT, model: 'Qwen-Coder-Next' },
    });
  }

  async function startImport(
    files: Record<string, string>,
    fields: Record<string, string> = {},
  ): Promise<{ statusCode: number; json: () => { jobId: string } & Record<string, unknown> }> {
    const { body, contentType } = multipart(fields, {
      field: 'file',
      filename: 'docs.zip',
      content: zipBuffer(files),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    return { statusCode: res.statusCode, json: () => res.json() };
  }

  async function pollUntilDone(jobId: string): Promise<AiImportJobView> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/ai-import/${jobId}` });
      expect(res.statusCode).toBe(200);
      const view = res.json() as AiImportJobView;
      if (view.status !== 'running') return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not finish in time');
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('multipart zip → 202 {jobId} → poll to succeeded → requirements really created', async () => {
    await boot(okClient());
    await configure();

    const start = await startImport({ 'auth.md': '# Вход\nВход по email и паролю.' });
    expect(start.statusCode).toBe(202);
    const { jobId } = start.json();
    expect(jobId).toBeTruthy();

    const view = await pollUntilDone(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.progress).toBe(100);
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 0,
    });

    const list = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/requirements` });
    expect(list.statusCode).toBe(200);
    const { requirements } = list.json() as { requirements: Array<Record<string, unknown>> };
    expect(requirements.map((r) => r.name).sort()).toEqual(['Время отклика', 'Вход по паролю']);
    // todo_18: import calls send the model's full generation budget as
    // max_tokens; 'Qwen-Coder-Next' has no dedicated preset → generic 4000.
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    // todo_20 T-209: import calls carry per-request options (signal/timeout).
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.2, max_tokens: 4000, model: 'Qwen-Coder-Next' }),
      expect.anything(),
    );
  });

  it('respects the optional model override field', async () => {
    await boot(okClient('[]'));
    await configure();
    const start = await startImport({ 'a.md': 'Текст.' }, { model: 'Override-Model' });
    expect(start.statusCode).toBe(202);
    await pollUntilDone(start.json().jobId);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Override-Model' }),
      expect.anything(),
    );
  });

  it('todo_16 B2: inferLinks field — "true" runs the relate step, "false"/omitted does not', async () => {
    await boot(okClient('[]'));
    await configure();

    const on = await startImport({ 'a.md': 'Текст.' }, { inferLinks: 'true' });
    expect(on.statusCode).toBe(202);
    const onView = await pollUntilDone(on.json().jobId);
    expect(onView.status).toBe('succeeded');
    // Nothing was extracted → nothing to relate, but the step IS reported.
    expect(onView.relate).toEqual({ status: 'done', created: 0 });

    const off = await startImport({ 'b.md': 'Текст.' }, { inferLinks: 'false' });
    expect(off.statusCode).toBe(202);
    const offView = await pollUntilDone(off.json().jobId);
    expect(offView.status).toBe('succeeded');
    expect(offView.relate).toBeUndefined();

    const omitted = await startImport({ 'c.md': 'Текст.' });
    const omittedView = await pollUntilDone(omitted.json().jobId);
    expect(omittedView.relate).toBeUndefined();
  });

  it('todo_16 B2: 400 for an invalid inferLinks value', async () => {
    await boot(okClient('[]'));
    await configure();
    const res = await startImport({ 'a.md': 'Текст.' }, { inferLinks: 'да' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message?: string }).message).toContain('inferLinks');
  });

  it('409 when a second import starts while the first is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => {
            await gate;
            return { choices: [{ message: { content: '[]' } }] };
          }),
        },
      },
    };
    await boot(slow);
    await configure();

    const first = await startImport({ 'a.md': 'Текст.' });
    expect(first.statusCode).toBe(202);
    const second = await startImport({ 'b.md': 'Текст.' });
    expect(second.statusCode).toBe(409);

    release();
    const view = await pollUntilDone(first.json().jobId);
    expect(view.status).toBe('succeeded');
  });

  it('400 with the spec §4 text when the AI key is not configured', async () => {
    await boot(okClient());
    const res = await startImport({ 'a.md': 'Текст.' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message?: string }).message).toContain('Настройте AI Hub');
  });

  it('404 for an unknown project and for an unknown jobId', async () => {
    await boot(okClient());
    await configure();
    const { body, contentType } = multipart(
      {},
      {
        field: 'file',
        filename: 'docs.zip',
        content: zipBuffer({ 'a.md': 'x' }),
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/NoSuchProject/ai-import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(404);

    const get = await app.inject({ method: 'GET', url: '/api/ai-import/no-such-job' });
    expect(get.statusCode).toBe(404);
    const cancel = await app.inject({ method: 'POST', url: '/api/ai-import/no-such-job/cancel' });
    expect(cancel.statusCode).toBe(404);
  });

  it('400 when no file part is present in the upload', async () => {
    await boot(okClient());
    await configure();
    const boundary = `----po${randomBytes(8).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nM\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('cancel: POST /cancel stops the job at the next chunk boundary', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => {
            await gate;
            return { choices: [{ message: { content: '[]' } }] };
          }),
        },
      },
    };
    await boot(slow);
    await configure();

    const start = await startImport({
      // Two files → at least two chunks, so a boundary exists after the first call.
      'a.md': 'Первый файл.',
      'b.md': 'Второй файл.',
    });
    const { jobId } = start.json();

    const cancel = await app.inject({ method: 'POST', url: `/api/ai-import/${jobId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    release();

    const view = await pollUntilDone(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.result).toBeDefined();
    // Cancel again after completion — idempotent no-op.
    const again = await app.inject({ method: 'POST', url: `/api/ai-import/${jobId}/cancel` });
    expect(again.statusCode).toBe(200);
    expect((again.json() as AiImportJobView).status).toBe('cancelled');
  });

  it('failed job carries the stage error + hint (archive without docs)', async () => {
    await boot(okClient());
    await configure();
    const start = await startImport({ 'image.bin': 'not-docs' });
    expect(start.statusCode).toBe(202);
    const view = await pollUntilDone(start.json().jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.error?.hint).toContain('нет файлов документации');
  });

  it('zip-slip: an entry with ../ never escapes the extraction temp dir (NFR-5)', async () => {
    await boot(okClient());
    await configure();

    // adm-zip sanitizes `../` in addFile(), so a genuinely malicious archive
    // is produced by byte-patching an equal-length placeholder name in both
    // the local header and the central directory.
    const evilHex = randomBytes(8).toString('hex');
    const evilName = `po-evil-${evilHex}.md`; // 27 chars
    const placeholder = `AA/po-evil-${evilHex}.md`; // same length as ../<evilName>
    const zip = new AdmZip();
    zip.addFile('good.md', Buffer.from('Обычная документация.', 'utf8'));
    zip.addFile(placeholder, Buffer.from('evil', 'utf8'));
    const raw = zip.toBuffer();
    const from = Buffer.from(placeholder);
    // The extraction dir lives directly under os.tmpdir(), so `../<name>`
    // resolves to os.tmpdir()/<name> — assert that file is never written.
    const to = Buffer.from(`../${evilName}`);
    for (let idx = raw.indexOf(from); idx !== -1; idx = raw.indexOf(from)) {
      to.copy(raw, idx);
    }
    const { body, contentType } = multipart(
      {},
      {
        field: 'file',
        filename: 'docs.zip',
        content: raw,
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const view = await pollUntilDone((res.json() as { jobId: string }).jobId);

    // The malicious entry is skipped (warn in the log), the good doc analyzed.
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('небезопасных'))).toBe(
      true,
    );
    await expect(fs.access(path.join(os.tmpdir(), evilName))).rejects.toThrow();
  });
});
