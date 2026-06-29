import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../src/lib/atomicWrite.js';

describe('T-302 atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'po-aw-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes content and leaves no temp file behind', async () => {
    const target = path.join(dir, 'a.txt');
    await atomicWrite(target, 'hello');
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites an existing file atomically', async () => {
    const target = path.join(dir, 'a.txt');
    await atomicWrite(target, 'v1');
    await atomicWrite(target, 'v2');
    expect(await fs.readFile(target, 'utf8')).toBe('v2');
  });

  it('on failure leaves no partial file and preserves the previous content', async () => {
    // Destination is a directory → rename fails; previous file content (none) preserved.
    const target = path.join(dir, 'dest');
    await fs.mkdir(target); // make destination a directory so rename(tmp -> dir) fails
    await expect(atomicWrite(target, 'data')).rejects.toBeTruthy();
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
    // The directory is intact (not replaced by a partial file).
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('handles concurrent writes to distinct files', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => atomicWrite(path.join(dir, `f${i}.txt`), `n${i}`)),
    );
    for (let i = 0; i < 10; i++) {
      expect(await fs.readFile(path.join(dir, `f${i}.txt`), 'utf8')).toBe(`n${i}`);
    }
  });
});
