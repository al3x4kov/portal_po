import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AI_IMPORT_MAX_ARCHIVE_BYTES } from '@po/core';
import { buildApp } from '../src/app.js';
import {
  BODY_LIMIT_BYTES,
  DEFAULT_ARCHIVE_LIMITS,
  MAX_UNPACK_ENTRIES,
  MAX_UNPACK_TOTAL_BYTES,
  MAX_UPLOAD_BYTES,
} from '../src/lib/limits.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** Build a multipart/form-data payload for inject (as ai-import-routes.test.ts). */
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

function bigZip(bytes: number): Buffer {
  const zip = new AdmZip();
  zip.addFile('openspec/specs/functions/big.md', Buffer.from('x'.repeat(bytes)));
  return zip.toBuffer();
}

describe('ARCH-6 upload limits — single source of truth', () => {
  it('MAX_UPLOAD_BYTES equals the product archive/AI-import limit', () => {
    expect(MAX_UPLOAD_BYTES).toBe(AI_IMPORT_MAX_ARCHIVE_BYTES);
  });

  it('default unpack limits are the bomb-guard constants', () => {
    expect(DEFAULT_ARCHIVE_LIMITS.maxEntries).toBe(MAX_UNPACK_ENTRIES);
    expect(DEFAULT_ARCHIVE_LIMITS.maxTotalBytes).toBe(MAX_UNPACK_TOTAL_BYTES);
  });

  it('body limit is defined and below the upload limit', () => {
    expect(BODY_LIMIT_BYTES).toBeGreaterThan(0);
    expect(BODY_LIMIT_BYTES).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });
});

describe('ARCH-6 multipart upload is bounded at the stream boundary', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('AI-import: rejects an oversize archive early, before writing it in full', async () => {
    // Small per-file cap so the test needn't move 50 MB; the upload exceeds it.
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      uploadFileSizeLimit: 1024,
    });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Cap' } });

    const { body, contentType } = multipart(
      {},
      { field: 'file', filename: 'docs.zip', content: bigZip(8192) },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Cap/ai-import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('project import: rejects an oversize archive early, before writing it in full', async () => {
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      uploadFileSizeLimit: 1024,
    });

    const { body, contentType } = multipart(
      { name: 'TooBigUpload' },
      { field: 'file', filename: 'proj.zip', content: bigZip(8192) },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    await expect(fs.stat(`${root}/TooBigUpload`)).rejects.toBeTruthy();
  });
});
