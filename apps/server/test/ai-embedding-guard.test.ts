import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AiClient } from '../src/services/AiHubService.js';
import { backlogXlsxBuffer } from './aiImportKit.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/*
 * Защита от embedding-моделей: они не умеют chat completions, поэтому выбор
 * такой модели для импорта (docs/backlog), чата и генерации описания должен
 * падать сразу — человеческим 400, а не тайм-аутом/ошибкой хаба.
 */

const SECRET = 'sk-embedding-guard';
const PROJECT = 'Demo';

function multipart(
  fields: Record<string, string>,
  file: { filename: string; content: Buffer },
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
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function zipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('embedding-модель → 400 на старте AI-операций', () => {
  let root: string;
  let app: FastifyInstance;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await makeTmpRoot();
    create = vi.fn(async () => ({ choices: [{ message: { content: '[]' } }] }));
    const client: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: { completions: { create } },
    };
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      makeAiClient: () => client,
    });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: PROJECT } });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: PROJECT, model: 'deepseek-ai/DeepSeek-V4-Flash' },
    });
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('docs-импорт с override embedding-моделью → 400, ни одного вызова хаба', async () => {
    const { body, contentType } = multipart(
      { model: 'Embeddings' },
      { filename: 'docs.zip', content: zipBuffer({ 'doc.md': '# Док' }) },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const msg = (res.json() as { message: string }).message;
    expect(msg).toContain('Embeddings');
    expect(msg).toContain('embedding-модель');
    expect(msg).toContain('Выберите чат-модель');
    expect(create).not.toHaveBeenCalled();
  });

  it('backlog-импорт с override embedding-моделью → 400', async () => {
    const xlsx = backlogXlsxBuffer([
      ['Issue key', 'Summary'],
      ['AB-1', 'Печать отчёта'],
    ]);
    const { body, contentType } = multipart(
      { model: 'BAAI/bge-m3' },
      { filename: 'Книга2.xlsx', content: xlsx },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const msg = (res.json() as { message: string }).message;
    expect(msg).toContain('BAAI/bge-m3');
    expect(msg).toContain('embedding-модель');
    expect(create).not.toHaveBeenCalled();
  });

  it('импорт с per-project embedding-моделью (без override) → 400', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { projectId: PROJECT, model: 'EmbeddingsGigaR' },
    });
    const { body, contentType } = multipart(
      {},
      { filename: 'docs.zip', content: zipBuffer({ 'doc.md': '# Док' }) },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain('EmbeddingsGigaR');
  });

  it('чат-виджет с embedding-моделью → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        model: 'Qwen/Qwen3-VL-Embedding-8B',
        messages: [{ role: 'user', content: 'Привет' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const msg = (res.json() as { message: string }).message;
    expect(msg).toContain('embedding-модель');
    expect(create).not.toHaveBeenCalled();
  });

  it('generate-description с per-project embedding-моделью → 400', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { projectId: PROJECT, model: 'Qodo/Qodo-Embed-1-1.5B' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-description',
      payload: {
        projectId: PROJECT,
        requirement: { name: 'Вход по паролю', type: 'FUNCTION', criticality: 'MEDIUM' },
      },
    });
    expect(res.statusCode).toBe(400);
    const msg = (res.json() as { message: string }).message;
    expect(msg).toContain('Qodo/Qodo-Embed-1-1.5B');
    expect(msg).toContain('embedding-модель');
    expect(create).not.toHaveBeenCalled();
  });

  it('чат-модель проходит гейт (регресс): docs-импорт стартует 202', async () => {
    const { body, contentType } = multipart(
      { model: 'GigaChat-2-Pro' },
      { filename: 'docs.zip', content: zipBuffer({ 'doc.md': '# Док' }) },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    // Дождаться завершения фонового прогона, чтобы afterEach не гонялся с ним.
    const { jobId } = res.json() as { jobId: string };
    for (let i = 0; i < 200; i++) {
      const view = await app.inject({ method: 'GET', url: `/api/ai-import/${jobId}` });
      const status = (view.json() as { status: string }).status;
      if (status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});
