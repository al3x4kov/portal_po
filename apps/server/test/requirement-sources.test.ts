import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@po/core';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { FsDictionariesRepo, DEFAULT_PRIORITY_ID } from '../src/repositories/FsDictionariesRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('T-114/T-115 RequirementService sources + releaseDate', () => {
  let root: string;
  let reqRepo: FsRequirementRepo;
  let dictRepo: FsDictionariesRepo;
  let svc: RequirementService;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    dictRepo = new FsDictionariesRepo(root, 'P');
    await dictRepo.seedDefault();
    reqRepo = new FsRequirementRepo(root, 'P');
    svc = new RequirementService(reqRepo, fixedNow, { dictionaries: dictRepo });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('persists sources and releaseDate through create + reload', async () => {
    const created = await svc.create(
      reqInput({
        name: 'R1',
        implemented: false,
        targetQuarter: 'Q3',
        targetYear: 2026,
        releaseDate: '2026-11-05',
        sources: [
          {
            type: 'CLIENT',
            name: 'Acme',
            priorityId: DEFAULT_PRIORITY_ID,
            rice: { reach: 4, impact: 3, confidence: 0.8, effort: 3 },
          },
        ],
      }),
    );
    expect(created.sources).toHaveLength(1);
    expect(created.releaseDate).toBe('2026-11-05');
    const { requirements } = await reqRepo.loadAll();
    const reloaded = requirements.find((r) => r.slug === created.slug)!;
    expect(reloaded.sources![0]).toMatchObject({ name: 'Acme', priorityId: DEFAULT_PRIORITY_ID });
  });

  it('rejects a source with an unknown priorityId (422)', async () => {
    await expect(
      svc.create(
        reqInput({ name: 'Bad', sources: [{ type: 'CLIENT', name: 'X', priorityId: 'ghost' }] }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('auto-collects a new source name into the dictionary on save (T-115)', async () => {
    await svc.create(
      reqInput({
        name: 'R2',
        sources: [{ type: 'STANDARD', name: 'ГОСТ 34', priorityId: DEFAULT_PRIORITY_ID }],
      }),
    );
    const dict = await dictRepo.read();
    expect(dict.sources.map((s) => s.name)).toContain('ГОСТ 34');
    expect(dict.sources.find((s) => s.name === 'ГОСТ 34')!.type).toBe('STANDARD');
  });

  it('does not duplicate an already-known source name (case-insensitive)', async () => {
    const dict = await dictRepo.read();
    dict.sources.push({ id: 's-existing', name: 'Acme', type: 'CLIENT' });
    await dictRepo.write(dict);
    await svc.create(
      reqInput({
        name: 'R3',
        sources: [{ type: 'CLIENT', name: ' acme ', priorityId: DEFAULT_PRIORITY_ID }],
      }),
    );
    const after = await dictRepo.read();
    expect(after.sources.filter((s) => s.name.trim().toLowerCase() === 'acme')).toHaveLength(1);
  });

  it('update persists sources too', async () => {
    const created = await svc.create(reqInput({ name: 'R4' }));
    const updated = await svc.update(created.slug, {
      name: 'R4',
      criticality: 'MEDIUM',
      implemented: true,
      sources: [{ type: 'TEXT', name: 'Doc', priorityId: DEFAULT_PRIORITY_ID }],
    });
    expect(updated.sources).toHaveLength(1);
  });
});
