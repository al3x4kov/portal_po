import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkInputSchema, requirementCreateSchema, requirementUpdateSchema } from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { createLinkService, createRequirementService } from '../src/factory.js';
import { createBody, updateBody } from '../src/routes/requirements.js';
import { linkBody } from '../src/routes/links.js';
import type { OpLogEntry, OpLogger } from '../src/lib/logger.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

const FUNCTIONS_DIR = path.join('openspec', 'specs', 'functions');

/** In-memory logger that captures every emitted operation entry. */
class CaptureLogger implements OpLogger {
  readonly entries: OpLogEntry[] = [];
  op(entry: OpLogEntry): void {
    this.entries.push(entry);
  }
}

describe('ARCH-4: REST routes use the canonical core input contracts', () => {
  it('createBody / updateBody / linkBody are the exact canonical schema instances', () => {
    // Reference equality: the REST body validators ARE the core contracts, so a
    // divergence between REST and MCP (which import the same objects) is impossible.
    expect(createBody).toBe(requirementCreateSchema);
    expect(updateBody).toBe(requirementUpdateSchema);
    expect(linkBody).toBe(linkInputSchema);
  });
});

describe('SA-4: requirements without a complete acceptance criterion are flagged', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const writeReq = async (slug: string, body: string[]): Promise<void> => {
    const file = path.join(root, 'P', FUNCTIONS_DIR, `${slug}.md`);
    await fs.writeFile(file, `${body.join('\n')}\n`);
  };

  it('list() reports slugs of requirements with incomplete or missing scenarios', async () => {
    const base = [
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00.000Z',
      '- updatedAt: 2026-01-01T00:00:00.000Z',
    ];
    // A complete acceptance criterion (WHEN + THEN) → NOT flagged.
    await writeReq('complete', [
      '### Requirement: Complete',
      ...base,
      '',
      '#### Scenario: Happy',
      '- WHEN the user acts',
      '- THEN the system responds',
    ]);
    // An incomplete scenario (missing THEN) → flagged.
    await writeReq('partial', [
      '### Requirement: Partial',
      ...base,
      '',
      '#### Scenario: Half',
      '- GIVEN a state',
      '- WHEN the user acts',
    ]);
    // No scenarios at all → flagged (no acceptance criterion).
    await writeReq('bare', ['### Requirement: Bare', ...base]);

    const service = createRequirementService({ projectsRoot: root, now: fixedNow }, 'P');
    const result = await service.list();

    expect(result.incomplete).toContain('partial');
    expect(result.incomplete).toContain('bare');
    expect(result.incomplete).not.toContain('complete');
  });
});

describe('ARCH-7: mutating services emit structured operation logs', () => {
  let root: string;
  let logger: CaptureLogger;

  beforeEach(async () => {
    root = await makeTmpRoot();
    logger = new CaptureLogger();
    await new FsProjectRepo(root).create('P', fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('logs a well-formed entry for a successful create', async () => {
    const service = createRequirementService(
      { projectsRoot: root, now: fixedNow, log: logger },
      'P',
    );
    await service.create(reqInput({ name: 'Login' }));

    const entry = logger.entries.find((e) => e.op === 'create');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ op: 'create', projectId: 'P', slug: 'login', outcome: 'ok' });
    expect(typeof entry?.durationMs).toBe('number');
  });

  it('logs an error entry carrying the domain error code on failure', async () => {
    const service = createRequirementService(
      { projectsRoot: root, now: fixedNow, log: logger },
      'P',
    );
    await service.create(reqInput({ name: 'Dup' }));
    await expect(service.create(reqInput({ name: 'dup' }))).rejects.toThrow();

    const errorEntry = logger.entries.find((e) => e.op === 'create' && e.outcome === 'error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.code).toBe('UNIQUENESS');
    expect(errorEntry?.projectId).toBe('P');
  });

  it('logs link/unlink operations for the link service', async () => {
    const reqs = createRequirementService({ projectsRoot: root, now: fixedNow }, 'P');
    await reqs.create(reqInput({ name: 'Parent' }));
    await reqs.create(reqInput({ name: 'Child' }));

    const links = createLinkService({ projectsRoot: root, now: fixedNow, log: logger }, 'P');
    await links.create({ sourceSlug: 'parent', type: 'PARENT_OF', targetSlug: 'child' });
    await links.remove({ sourceSlug: 'parent', type: 'PARENT_OF', targetSlug: 'child' });

    expect(logger.entries.map((e) => e.op)).toEqual(['link', 'unlink']);
    expect(logger.entries.every((e) => e.outcome === 'ok' && e.projectId === 'P')).toBe(true);
  });

  it('is a silent no-op when no logger is injected', async () => {
    // The FsRequirementRepo is exercised directly; no logger means no entries.
    const repo = new FsRequirementRepo(root, 'P');
    const service = createRequirementService({ projectsRoot: root, now: fixedNow }, 'P');
    await service.create(reqInput({ name: 'Quiet' }));
    const { requirements } = await repo.loadAll();
    expect(requirements.map((r) => r.slug)).toContain('quiet');
    expect(logger.entries).toHaveLength(0);
  });
});
