import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectService } from '../src/factory.js';
import { ArchiveError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/**
 * SA-3: an archive whose individual `.md` all parse but whose LINK GRAPH breaks
 * the 2.4 invariants (cycle / dangling target / second parent / self-link) must
 * be REJECTED with a list of concrete violations. The target project directory
 * must never be created and the import temp must be cleaned (FR-3.4).
 */
describe('SA-3 import rejects a graph-invalid archive', () => {
  let root: string;
  let svc: ReturnType<typeof createProjectService>;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    svc = createProjectService({ projectsRoot: root, now: fixedNow });
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-sa3-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const md = (name: string, links: string[]): Buffer =>
    Buffer.from(
      [
        `### Requirement: ${name}`,
        '- criticality: MEDIUM',
        '- implemented: true',
        '- createdAt: 2026-01-01T00:00:00Z',
        '- updatedAt: 2026-01-01T00:00:00Z',
        '',
        '#### Links',
        ...links,
        '',
      ].join('\n'),
    );

  async function writeZip(
    files: ReadonlyArray<{ rel: string; body: Buffer }>,
    name: string,
  ): Promise<string> {
    const zip = new AdmZip();
    for (const f of files) zip.addFile(f.rel, f.body);
    const file = path.join(scratch, `${name}.zip`);
    await fs.writeFile(file, zip.toBuffer());
    return file;
  }

  /** Assert import failed atomically: no target dir, temp swept, details listed. */
  async function expectRejected(file: string, projectName: string): Promise<ArchiveError> {
    let caught: unknown;
    await svc.import(file, projectName).then(
      () => {
        throw new Error('import should have been rejected');
      },
      (err: unknown) => {
        caught = err;
      },
    );
    expect(caught).toBeInstanceOf(ArchiveError);
    const err = caught as ArchiveError;
    expect(err.details).toBeDefined();
    expect(Array.isArray(err.details)).toBe(true);
    expect((err.details ?? []).length).toBeGreaterThan(0);
    // Target directory never created.
    await expect(fs.stat(path.join(root, projectName))).rejects.toBeTruthy();
    // Import temp is swept clean.
    const leftovers = await fs.readdir(path.join(root, '.import-tmp')).catch(() => []);
    expect(leftovers).toEqual([]);
    return err;
  }

  it('S35 rejects a PARENT_OF hierarchy cycle', async () => {
    const file = await writeZip(
      [
        {
          rel: 'openspec/specs/functions/a.md',
          body: md('Alpha', ['- CHILD_OF: b', '- PARENT_OF: b']),
        },
        {
          rel: 'openspec/specs/functions/b.md',
          body: md('Beta', ['- CHILD_OF: a', '- PARENT_OF: a']),
        },
      ],
      'cycle',
    );
    const err = await expectRejected(file, 'CycleGraph');
    expect(err.details?.some((d) => /cycle/i.test(d))).toBe(true);
  });

  it('S36 rejects a dangling targetSlug (link into nowhere)', async () => {
    const file = await writeZip(
      [{ rel: 'openspec/specs/functions/a.md', body: md('Alpha', ['- RELATES_TO: ghost']) }],
      'dangling',
    );
    const err = await expectRejected(file, 'DanglingGraph');
    expect(err.details?.some((d) => d.includes('ghost'))).toBe(true);
  });

  it('S37 rejects a requirement with a second parent', async () => {
    const file = await writeZip(
      [
        { rel: 'openspec/specs/functions/p1.md', body: md('ParentOne', ['- PARENT_OF: c']) },
        { rel: 'openspec/specs/functions/p2.md', body: md('ParentTwo', ['- PARENT_OF: c']) },
        {
          rel: 'openspec/specs/functions/c.md',
          body: md('Child', ['- CHILD_OF: p1', '- CHILD_OF: p2']),
        },
      ],
      'multiparent',
    );
    const err = await expectRejected(file, 'MultiParentGraph');
    expect(err.details?.some((d) => /parent/i.test(d))).toBe(true);
  });

  it('S38 rejects a self-link', async () => {
    const file = await writeZip(
      [{ rel: 'openspec/specs/functions/a.md', body: md('Alpha', ['- RELATES_TO: a']) }],
      'selflink',
    );
    const err = await expectRejected(file, 'SelfLinkGraph');
    expect(err.details?.some((d) => /self-link/i.test(d))).toBe(true);
  });
});
