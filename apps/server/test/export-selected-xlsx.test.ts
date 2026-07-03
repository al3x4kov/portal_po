/**
 * Bug fix — POST /api/projects/:id/export/selected must honour `format: 'xlsx'`,
 * producing a workbook that contains ONLY the selected slugs (with the `fields`
 * column selection applied), unlike GET /export.xlsx which exports everything.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function md(name: string): string {
  return [
    `### Requirement: ${name}`,
    '- criticality: MEDIUM',
    '- implemented: true',
    '- createdAt: 2026-01-01T00:00:00.000Z',
    '- updatedAt: 2026-01-01T00:00:00.000Z',
    '- source: АС21',
    '',
    'Body description text.',
    '',
    '#### Info',
    '- Регламент: РД-42',
    '',
  ].join('\n');
}

async function seed(root: string, projectId: string): Promise<void> {
  const dir = path.join(root, projectId, 'openspec', 'specs', 'functions');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, projectId, 'openspec', 'specs', 'nfr'), { recursive: true });
  const manifest = [
    '---',
    `name: ${projectId}`,
    'schemaVersion: 1',
    'createdAt: 2026-01-01T00:00:00.000Z',
    '---',
    '',
  ].join('\n');
  await fs.writeFile(path.join(root, projectId, 'openspec', 'project.md'), manifest);
  await fs.writeFile(path.join(dir, 'login.md'), md('Login'));
  await fs.writeFile(path.join(dir, 'logout.md'), md('Logout'));
  await fs.writeFile(path.join(dir, 'signup.md'), md('Signup'));
}

async function toBuffer(body: Buffer | Readable | string): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb.getWorksheet('Требования')!;
}

/** Requirement names in column 1 (data rows only). */
function names(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  for (let r = 2; r <= ws.rowCount; r += 1) out.push(String(ws.getRow(r).getCell(1).value ?? ''));
  return out;
}

describe('POST /export/selected — format: xlsx', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
    await seed(root, 'Alpha');
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('returns an xlsx workbook containing ONLY the selected slugs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'xlsx', slugs: ['login', 'signup'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX_CONTENT_TYPE);
    expect(res.headers['content-disposition']).toContain('Alpha.xlsx');

    const buf = await toBuffer(res.rawPayload);
    // .xlsx is a zip container → PK signature + non-empty.
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const ws = await loadWorkbook(buf);
    const rowNames = names(ws).map((n) => n.trim());
    expect(new Set(rowNames)).toEqual(new Set(['Login', 'Signup']));
    expect(rowNames).not.toContain('Logout');
  });

  it('applies the fields selection (empty fields → 4 base columns)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'xlsx', slugs: ['login'], fields: [] },
    });
    expect(res.statusCode).toBe(200);
    const ws = await loadWorkbook(await toBuffer(res.rawPayload));
    const header: string[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) header.push(String(ws.getRow(1).getCell(c).value));
    expect(header).toEqual(['Требование', 'Тип', 'Критичность', 'Реализация']);
    expect(names(ws).map((n) => n.trim())).toEqual(['Login']);
  });

  it('applies the fields selection (source,links → 6 columns)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'xlsx', slugs: ['login'], fields: ['source', 'links'] },
    });
    expect(res.statusCode).toBe(200);
    const ws = await loadWorkbook(await toBuffer(res.rawPayload));
    const header: string[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) header.push(String(ws.getRow(1).getCell(c).value));
    expect(header).toEqual(['Требование', 'Тип', 'Критичность', 'Реализация', 'Источник', 'Связи']);
  });

  it('rejects an invalid format with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'pdf', slugs: ['login'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid fields value with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'xlsx', slugs: ['login'], fields: ['bogus'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty slugs array with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'xlsx', slugs: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
