import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveRepo } from '../src/repositories/ArchiveRepo.js';
import { ProjectService } from '../src/services/ProjectService.js';
import { ArchiveError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** A minimal, parseable requirement markdown body. */
function reqMd(name: string): Buffer {
  return Buffer.from(
    [
      `### Requirement: ${name}`,
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '',
    ].join('\n'),
  );
}

describe('ARCH-6 / ARCH-10 / QA-8 import safety', () => {
  let root: string;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-sec-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('ARCH-6: rejects a cross-type duplicate slug and creates no project dir', async () => {
    const zip = new AdmZip();
    zip.addFile('openspec/specs/functions/dup.md', reqMd('Func Dup'));
    zip.addFile('openspec/specs/nfr/dup.md', reqMd('Nfr Dup'));
    const file = path.join(scratch, 'dup.zip');
    await fs.writeFile(file, zip.toBuffer());

    const svc = new ProjectService(root, fixedNow);
    await expect(svc.import(file, 'DupProj')).rejects.toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'DupProj'))).rejects.toBeTruthy();
  });

  it('QA-8: rejects a .tar.gz entry that escapes via path traversal', async () => {
    // Build a tar.gz whose sole entry is "../escape.md".
    const src = path.join(scratch, 'src');
    const inner = path.join(src, 'inner');
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(src, 'escape.md'), 'pwned');
    const file = path.join(scratch, 'evil.tgz');
    await tar.c({ gzip: true, file, cwd: inner }, ['../escape.md']);

    const svc = new ProjectService(root, fixedNow);
    await expect(svc.import(file, 'EvilTar')).rejects.toBeTruthy();
    // Nothing was written above the Projects root.
    await expect(fs.stat(path.join(path.dirname(root), 'escape.md'))).rejects.toBeTruthy();
    await expect(fs.stat(path.join(root, 'EvilTar'))).rejects.toBeTruthy();
  });

  it('ARCH-10: rejects a zip exceeding the entry-count limit (bomb-guard)', async () => {
    const zip = new AdmZip();
    zip.addFile('openspec/project.md', Buffer.from('# name: X\n'));
    zip.addFile('openspec/specs/functions/a.md', reqMd('A'));
    zip.addFile('openspec/specs/functions/b.md', reqMd('B'));
    const file = path.join(scratch, 'many.zip');
    await fs.writeFile(file, zip.toBuffer());

    const repo = new ArchiveRepo(root, { maxEntries: 2 });
    await expect(repo.import(file, 'TooMany')).rejects.toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'TooMany'))).rejects.toBeTruthy();
  });

  it('ARCH-10: rejects a zip exceeding the uncompressed size limit', async () => {
    const zip = new AdmZip();
    zip.addFile('openspec/specs/functions/big.md', Buffer.from('x'.repeat(4096)));
    const file = path.join(scratch, 'big.zip');
    await fs.writeFile(file, zip.toBuffer());

    const repo = new ArchiveRepo(root, { maxTotalBytes: 1024 });
    await expect(repo.import(file, 'TooBig')).rejects.toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'TooBig'))).rejects.toBeTruthy();
  });

  it('ARCH-10: rejects a .tar.gz exceeding the uncompressed size limit', async () => {
    const src = path.join(scratch, 'tsrc', 'openspec', 'specs', 'functions');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'big.md'), 'y'.repeat(8192));
    const file = path.join(scratch, 'big.tgz');
    await tar.c({ gzip: true, file, cwd: path.join(scratch, 'tsrc') }, ['.']);

    const repo = new ArchiveRepo(root, { maxTotalBytes: 1024 });
    await expect(repo.import(file, 'TooBigTar')).rejects.toBeInstanceOf(ArchiveError);
    await expect(fs.stat(path.join(root, 'TooBigTar'))).rejects.toBeTruthy();
  });

  it('imports a well-formed archive within limits (default limits unaffected)', async () => {
    const zip = new AdmZip();
    zip.addFile('openspec/specs/functions/ok.md', reqMd('Ok One'));
    const file = path.join(scratch, 'ok.zip');
    await fs.writeFile(file, zip.toBuffer());

    const svc = new ProjectService(root, fixedNow);
    const project = await svc.import(file, 'GoodProj');
    expect(project.id).toBe('GoodProj');
  });
});
