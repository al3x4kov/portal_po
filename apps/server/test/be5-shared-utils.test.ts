import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectArchiveFormat } from '../src/lib/archiveFormat.js';
import { sanitize } from '../src/lib/redact.js';
import { ArchiveError } from '../src/lib/errors.js';

describe('BE-5 shared detectArchiveFormat (single source)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'po-fmt-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (bytes: number[]): Promise<string> => {
    const file = path.join(dir, `a-${randomBytes(4).toString('hex')}.bin`);
    await fs.writeFile(file, Buffer.from(bytes));
    return file;
  };

  it('detects a zip archive by the "PK" magic bytes', async () => {
    const file = await write([0x50, 0x4b, 0x03, 0x04]);
    await expect(detectArchiveFormat(file)).resolves.toBe('zip');
  });

  it('detects a gzip (tar.gz) archive by the 0x1f 0x8b magic bytes', async () => {
    const file = await write([0x1f, 0x8b, 0x08, 0x00]);
    await expect(detectArchiveFormat(file)).resolves.toBe('targz');
  });

  it('rejects unknown/garbage leading bytes with an ArchiveError', async () => {
    const file = await write([0x00, 0x01, 0x02, 0x03]);
    await expect(detectArchiveFormat(file)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe('BE-5 shared sanitize (secret redaction, single source)', () => {
  it('redacts every occurrence of the API key from a message', () => {
    const key = 'sk-super-secret-123';
    const msg = `boom ${key} and again ${key}`;
    const out = sanitize(msg, key);
    expect(out).not.toContain(key);
    expect(out).toBe('boom *** and again ***');
  });

  it('is a no-op when no key is configured (empty key)', () => {
    expect(sanitize('nothing to redact', '')).toBe('nothing to redact');
  });
});
