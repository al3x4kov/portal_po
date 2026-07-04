import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/**
 * PO-T4 · byte-determinism of exports — the fit-criterion of the "AI-ready"
 * value proposition (spec §1.2): the same unchanged project must always export
 * the same bytes, "no fields param" must equal "all fields selected", and a
 * re-imported archive must re-export to the same normalized entry set.
 */

const PROJECT = 'Det';

/** Unpack an archive body into a normalized rel-path → content map. */
async function entriesOf(body: Buffer, format: 'zip' | 'targz'): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (format === 'zip') {
    const zip = new AdmZip(body);
    for (const e of zip.getEntries()) {
      if (!e.isDirectory) map.set(e.entryName.replace(/\\/g, '/'), e.getData().toString('utf8'));
    }
    return map;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'po-det-untar-'));
  const file = path.join(dir, 'a.tar.gz');
  await fs.writeFile(file, body);
  await tar.x({ file, cwd: dir });
  const walk = async (d: string, base: string): Promise<void> => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      if (ent.name === 'a.tar.gz') continue;
      const abs = path.join(d, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(abs, rel);
      else map.set(rel, await fs.readFile(abs, 'utf8'));
    }
  };
  await walk(dir, '');
  await fs.rm(dir, { recursive: true, force: true });
  return map;
}

function expectSameEntries(a: Map<string, string>, b: Map<string, string>): void {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [rel, content] of a) {
    expect(b.get(rel), `entry ${rel}`).toBe(content);
  }
}

/** Multipart body for POST /api/projects/import (as ai-import-routes tests). */
function importPayload(
  name: string,
  archive: Buffer,
  filename: string,
): { body: Buffer; contentType: string } {
  const boundary = `----po${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('PO-T4 · export determinism (openspec text + archives)', () => {
  let app: FastifyInstance;
  let root: string;

  async function post(url: string, payload: unknown): Promise<void> {
    const res = await app.inject({ method: 'POST', url, payload: payload as object });
    expect(res.statusCode, res.body).toBeLessThan(300);
  }

  async function exportBuffer(url: string): Promise<Buffer> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    return Buffer.from(res.rawPayload);
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
    await post('/api/projects', { name: PROJECT });
    // A representative project: hierarchy + optional fields + an NFR with target.
    await post(`/api/projects/${PROJECT}/requirements`, {
      type: 'FUNCTION',
      name: 'Родитель',
      criticality: 'HIGH',
      implemented: true,
      description: 'Раздел верхнего уровня.',
      source: 'АС21',
      infoItems: [{ type: 'Регламент', value: 'РД-42' }],
    });
    await post(`/api/projects/${PROJECT}/requirements`, {
      type: 'FUNCTION',
      name: 'Потомок',
      criticality: 'MEDIUM',
      implemented: true,
      description: 'Дочернее требование.',
    });
    await post(`/api/projects/${PROJECT}/requirements`, {
      type: 'NFR',
      name: 'Отклик',
      criticality: 'HIGH',
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
    });
    await post(`/api/projects/${PROJECT}/links`, {
      sourceSlug: 'roditel',
      type: 'PARENT_OF',
      targetSlug: 'potomok',
    });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('(a) GET …/requirements?format=openspec twice on an unchanged project → byte-identical', async () => {
    const first = await exportBuffer(`/api/projects/${PROJECT}/requirements?format=openspec`);
    const second = await exportBuffer(`/api/projects/${PROJECT}/requirements?format=openspec`);
    expect(first.equals(second)).toBe(true);
    expect(first.length).toBeGreaterThan(0);
  });

  for (const format of ['zip', 'targz'] as const) {
    it(`(b) ${format}: export WITHOUT fields param == export with ALL fields selected (entry contents)`, async () => {
      const lossless = await exportBuffer(`/api/projects/${PROJECT}/export?format=${format}`);
      const allFields = await exportBuffer(
        `/api/projects/${PROJECT}/export?format=${format}&fields=source,description,info,links`,
      );
      const a = await entriesOf(lossless, format);
      const b = await entriesOf(allFields, format);
      expectSameEntries(a, b);
    });

    it(`(b') ${format}: the same export twice → identical entry contents`, async () => {
      const first = await exportBuffer(`/api/projects/${PROJECT}/export?format=${format}`);
      const second = await exportBuffer(`/api/projects/${PROJECT}/export?format=${format}`);
      expectSameEntries(await entriesOf(first, format), await entriesOf(second, format));
    });
  }

  it('(c) re-import of an exported archive → a new export has the same normalized entry set', async () => {
    const original = await exportBuffer(`/api/projects/${PROJECT}/export?format=zip`);

    const { body, contentType } = importPayload('Det2', original, 'det.zip');
    const imported = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(imported.statusCode, imported.body).toBe(201);

    const reExported = await exportBuffer('/api/projects/Det2/export?format=zip');
    const a = await entriesOf(original, 'zip');
    const b = await entriesOf(reExported, 'zip');
    // Import copies the files verbatim (lossless), so every entry — including
    // the manifest — must round-trip byte-identically.
    expectSameEntries(a, b);

    // And the re-imported project keeps re-exporting deterministically.
    const again = await exportBuffer('/api/projects/Det2/export?format=zip');
    expectSameEntries(b, await entriesOf(again, 'zip'));
  });
});
