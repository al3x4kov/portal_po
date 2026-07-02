/**
 * T-525 — Integration tests for POST /api/projects/:id/export/selected
 *
 * Tests the partial-export endpoint that produces an archive containing only
 * the requested slugs (FUNCTION or NFR) plus the project manifest.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid requirement MD that the parser accepts. */
function reqMd(name: string): string {
  return [
    `### Requirement: ${name}`,
    '- criticality: MEDIUM',
    '- implemented: true',
    '- createdAt: 2026-01-01T00:00:00.000Z',
    '- updatedAt: 2026-01-01T00:00:00.000Z',
    '',
  ].join('\n');
}

/** Collect all entry names from a zip buffer. */
function zipEntries(buf: Buffer): string[] {
  const zip = new AdmZip(buf);
  return zip.getEntries().map((e) => e.entryName);
}

/** Collect all entry names from a tar.gz buffer written to disk first. */
async function tgzEntries(buf: Buffer, scratch: string): Promise<string[]> {
  const file = path.join(scratch, `tgz-${randomBytes(4).toString('hex')}.tar.gz`);
  await fs.writeFile(file, buf);
  const names: string[] = [];
  await tar.t({
    file,
    onentry: (entry: { path: string }) => {
      names.push(entry.path);
    },
  });
  return names;
}

/** Convert inject response body (Buffer or Readable) → Buffer. */
async function toBuffer(body: Buffer | Readable | string): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Fixture: seed a project with some requirement files directly on disk
// ---------------------------------------------------------------------------

async function seedProject(
  root: string,
  projectId: string,
  specs: Array<{ type: 'functions' | 'nfr'; slug: string; name: string }>,
): Promise<void> {
  // Ensure project directory structure.
  const projectDir = path.join(root, projectId);
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs', 'functions'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs', 'nfr'), { recursive: true });

  // Write a minimal manifest.
  const manifest = [
    '---',
    `name: ${projectId}`,
    'schemaVersion: 1',
    'createdAt: 2026-01-01T00:00:00.000Z',
    '---',
    '',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'openspec', 'project.md'), manifest);

  // Write requirement files.
  for (const spec of specs) {
    const dir = path.join(projectDir, 'openspec', 'specs', spec.type);
    await fs.writeFile(path.join(dir, `${spec.slug}.md`), reqMd(spec.name));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-525 POST /api/projects/:id/export/selected', () => {
  let app: FastifyInstance;
  let root: string;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-sel-'));
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });

    // Seed a project with three requirements: two FUNCTIONs, one NFR.
    await seedProject(root, 'Alpha', [
      { type: 'functions', slug: 'login', name: 'Login' },
      { type: 'functions', slug: 'logout', name: 'Logout' },
      { type: 'nfr', slug: 'perf', name: 'Performance' },
    ]);
  });

  afterEach(async () => {
    await app.close();
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Successful partial export — zip
  // -------------------------------------------------------------------------
  it('returns a zip archive containing only selected slugs + manifest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['login', 'perf'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*Alpha-partial\.zip/);

    const buf = await toBuffer(res.rawPayload);
    const entries = zipEntries(buf);

    // Manifest must always be present.
    expect(entries).toContain('openspec/project.md');
    // Selected function slug must be present.
    expect(entries.some((e) => e.includes('login'))).toBe(true);
    // Selected NFR slug must be present.
    expect(entries.some((e) => e.includes('perf'))).toBe(true);
    // Non-selected function slug must NOT be present.
    expect(entries.some((e) => e.includes('logout'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Successful partial export — targz
  // -------------------------------------------------------------------------
  it('returns a tar.gz archive for format=targz', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'targz', slugs: ['logout'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/gzip/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*Alpha-partial\.tar\.gz/);

    const buf = await toBuffer(res.rawPayload);
    const entries = await tgzEntries(buf, scratch);

    // Manifest must always be present.
    expect(entries.some((e) => e.includes('project.md'))).toBe(true);
    // Selected slug must be present.
    expect(entries.some((e) => e.includes('logout'))).toBe(true);
    // Non-selected slugs must NOT be present.
    expect(entries.some((e) => e.includes('login'))).toBe(false);
    expect(entries.some((e) => e.includes('perf'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Empty slugs array → 400
  // -------------------------------------------------------------------------
  it('returns 400 when slugs array is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 4. Non-existent slug is silently ignored; archive built from found ones
  // -------------------------------------------------------------------------
  it('ignores non-existent slugs and returns archive of found ones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['login', 'does-not-exist'] },
    });

    expect(res.statusCode).toBe(200);

    const buf = await toBuffer(res.rawPayload);
    const entries = zipEntries(buf);

    expect(entries).toContain('openspec/project.md');
    expect(entries.some((e) => e.includes('login'))).toBe(true);
    // Unknown slug must not appear.
    expect(entries.some((e) => e.includes('does-not-exist'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. Path traversal in slug → 400
  // -------------------------------------------------------------------------
  it('rejects a slug containing path traversal characters with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['../../../etc/passwd'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a slug with backslash path traversal with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['..\\windows\\system32'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a slug with uppercase letters with 400 (slug must be lowercase)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'zip', slugs: ['Login'] },
    });

    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 6. Project not found → 404
  // -------------------------------------------------------------------------
  it('returns 404 when project does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/ghost/export/selected',
      payload: { format: 'zip', slugs: ['login'] },
    });

    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 7. Missing format field → defaults or validates correctly
  // -------------------------------------------------------------------------
  it('returns 400 when format is missing from body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      // @ts-expect-error intentionally omitting required field
      payload: { slugs: ['login'] },
    });

    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 8. Invalid format value → 400
  // -------------------------------------------------------------------------
  it('returns 400 for an unsupported format value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Alpha/export/selected',
      payload: { format: 'rar', slugs: ['login'] },
    });

    expect(res.statusCode).toBe(400);
  });
});
