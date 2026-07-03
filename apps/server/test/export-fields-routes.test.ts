/**
 * T-202 — HTTP integration tests for the `fields` selection on the three export
 * endpoints: GET /export, POST /export/selected, GET /export.xlsx.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** A requirement MD with every optional section, so masks are observable. */
function richMd(name: string, extra: string[] = []): string {
  return [
    `### Requirement: ${name}`,
    '- criticality: MEDIUM',
    '- implemented: true',
    '- createdAt: 2026-01-01T00:00:00.000Z',
    '- updatedAt: 2026-01-01T00:00:00.000Z',
    '- source: АС21',
    '',
    'Body description text.',
    ...extra,
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
  await fs.writeFile(path.join(dir, 'login.md'), richMd('Login'));
}

async function toBuffer(body: Buffer | Readable | string): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function zipText(buf: Buffer, needle: string): string {
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => e.entryName.includes(needle));
  return entry ? entry.getData().toString('utf8') : '';
}

describe('T-202 export endpoints — fields selection', () => {
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

  it('GET /export without fields copies the file verbatim (all sections)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/Alpha/export?format=zip' });
    expect(res.statusCode).toBe(200);
    const md = zipText(await toBuffer(res.rawPayload), 'login.md');
    expect(md).toContain('- source: АС21');
    expect(md).toContain('Body description text.');
    expect(md).toContain('#### Info');
  });

  it('GET /export?fields=links reserializes to only the Links-eligible mask', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Alpha/export?format=zip&fields=links',
    });
    expect(res.statusCode).toBe(200);
    const md = zipText(await toBuffer(res.rawPayload), 'login.md');
    expect(md).toContain('### Requirement: Login');
    expect(md).not.toContain('- source:');
    expect(md).not.toContain('Body description text.');
    expect(md).not.toContain('#### Info');
  });

  it('GET /export?fields= (empty) yields the minimal mandatory-only mask', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Alpha/export?format=zip&fields=',
    });
    expect(res.statusCode).toBe(200);
    const md = zipText(await toBuffer(res.rawPayload), 'login.md');
    expect(md).toContain('- criticality:');
    expect(md).not.toContain('- source:');
    expect(md).not.toContain('#### Info');
  });

  it('GET /export drops unknown field tokens (parseExportFields is tolerant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Alpha/export?format=zip&fields=bogus,source',
    });
    expect(res.statusCode).toBe(200);
    const md = zipText(await toBuffer(res.rawPayload), 'login.md');
    expect(md).toContain('- source: АС21');
    expect(md).not.toContain('#### Info');
  });

  it('POST /export/selected accepts a fields array in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['login'], fields: ['source'] },
    });
    expect(res.statusCode).toBe(200);
    const md = zipText(await toBuffer(res.rawPayload), 'login.md');
    expect(md).toContain('- source: АС21');
    expect(md).not.toContain('#### Info');
  });

  it('POST /export/selected rejects an invalid fields value with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['login'], fields: ['bogus'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /export.xlsx?fields=source,links → 6 columns in order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Alpha/export.xlsx?fields=source,links',
    });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await toBuffer(res.rawPayload));
    const ws = wb.getWorksheet('Требования')!;
    const header: string[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) header.push(String(ws.getRow(1).getCell(c).value));
    expect(header).toEqual(['Требование', 'Тип', 'Критичность', 'Реализация', 'Источник', 'Связи']);
  });

  it('GET /export.xlsx without fields → 8 default columns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/Alpha/export.xlsx' });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await toBuffer(res.rawPayload));
    const ws = wb.getWorksheet('Требования')!;
    expect(ws.columnCount).toBe(8);
  });
});
