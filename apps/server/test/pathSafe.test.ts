import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRealpathWithin, resolveSafe } from '../src/lib/pathSafe.js';
import { PathSafetyError } from '../src/lib/errors.js';

describe('T-302 resolveSafe (path traversal)', () => {
  const root = path.resolve('/srv/Projects');

  it('resolves a normal nested path inside the root', () => {
    expect(resolveSafe(root, 'proj', 'requirements', 'x.md')).toBe(
      path.join(root, 'proj', 'requirements', 'x.md'),
    );
  });

  it('rejects ".." traversal', () => {
    expect(() => resolveSafe(root, '..', 'etc', 'passwd')).toThrow(PathSafetyError);
    expect(() => resolveSafe(root, 'proj', '..', '..', 'secret')).toThrow(PathSafetyError);
  });

  it('rejects an absolute segment that escapes the root', () => {
    expect(() => resolveSafe(root, '/etc/passwd')).toThrow(PathSafetyError);
  });

  it('rejects a sibling-prefix sneak (Projects-evil)', () => {
    expect(() => resolveSafe(root, '..', 'Projects-evil')).toThrow(PathSafetyError);
  });
});

describe('T-302 assertRealpathWithin (symlink escape)', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'po-sym-'));
    root = path.join(base, 'Projects');
    outside = path.join(base, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('accepts a real path inside the root', async () => {
    const inside = path.join(root, 'proj');
    await fs.mkdir(inside);
    await expect(assertRealpathWithin(root, inside)).resolves.toBe(inside);
  });

  it('rejects a symlink that points outside the root', async () => {
    const link = path.join(root, 'escape');
    await fs.symlink(outside, link);
    await expect(assertRealpathWithin(root, path.join(link, 'x.md'))).rejects.toBeInstanceOf(
      PathSafetyError,
    );
  });
});
