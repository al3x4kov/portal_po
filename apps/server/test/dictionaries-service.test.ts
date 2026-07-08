import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { FsDictionariesRepo, DEFAULT_PRIORITY_ID } from '../src/repositories/FsDictionariesRepo.js';
import { DictionariesService } from '../src/services/DictionariesService.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

describe('T-111 DictionariesService', () => {
  let root: string;
  let svc: DictionariesService;
  let reqRepo: FsRequirementRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    const dictRepo = new FsDictionariesRepo(root, 'P');
    await dictRepo.seedDefault();
    reqRepo = new FsRequirementRepo(root, 'P');
    svc = new DictionariesService({ dict: dictRepo, requirements: reqRepo, now: fixedNow });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  describe('priorities CRUD', () => {
    it('adds a priority with the next order and a generated id', async () => {
      const p = await svc.addPriority({ name: 'Критично', color: 'red' });
      expect(p).toMatchObject({ name: 'Критично', color: 'red', order: 1 });
      expect(p.id).not.toBe(DEFAULT_PRIORITY_ID);
      const all = await svc.get();
      expect(all.priorities).toHaveLength(2);
    });

    it('rejects a duplicate priority name (case-insensitive)', async () => {
      await expect(
        svc.addPriority({ name: '  квартальная цель ', color: 'blue' }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('renames / recolors / reorders a priority', async () => {
      const p = await svc.addPriority({ name: 'Mid', color: 'blue' });
      const up = await svc.updatePriority(p.id, { name: 'Middle', color: 'green', order: 5 });
      expect(up).toMatchObject({ name: 'Middle', color: 'green', order: 5 });
    });

    it('rejects renaming onto an existing name', async () => {
      const p = await svc.addPriority({ name: 'Mid', color: 'blue' });
      await expect(svc.updatePriority(p.id, { name: 'Квартальная цель' })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('updatePriority on unknown id → NotFound', async () => {
      await expect(svc.updatePriority('ghost', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('deletes an unused priority', async () => {
      const p = await svc.addPriority({ name: 'Temp', color: 'gray' });
      await svc.deletePriority(p.id);
      expect((await svc.get()).priorities.map((x) => x.id)).not.toContain(p.id);
    });

    it('refuses to delete a priority in use without reassignTo', async () => {
      const p = await svc.addPriority({ name: 'InUse', color: 'purple' });
      const reqSvc = new RequirementService(reqRepo, fixedNow);
      await reqSvc.create(
        reqInput({ name: 'R1', sources: [{ type: 'CLIENT', name: 'Acme', priorityId: p.id }] }),
      );
      await expect(svc.deletePriority(p.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('reassigns requirement sources when deleting a used priority with reassignTo', async () => {
      const p = await svc.addPriority({ name: 'InUse', color: 'purple' });
      const reqSvc = new RequirementService(reqRepo, fixedNow);
      const created = await reqSvc.create(
        reqInput({ name: 'R1', sources: [{ type: 'CLIENT', name: 'Acme', priorityId: p.id }] }),
      );
      await svc.deletePriority(p.id, DEFAULT_PRIORITY_ID);
      expect((await svc.get()).priorities.map((x) => x.id)).not.toContain(p.id);
      const { requirements } = await reqRepo.loadAll();
      const reloaded = requirements.find((r) => r.slug === created.slug)!;
      expect(reloaded.sources![0]!.priorityId).toBe(DEFAULT_PRIORITY_ID);
    });

    it('rejects reassignTo pointing at a non-existent priority', async () => {
      const p = await svc.addPriority({ name: 'InUse', color: 'purple' });
      await expect(svc.deletePriority(p.id, 'ghost')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('sources CRUD', () => {
    it('adds a source with a generated id', async () => {
      const s = await svc.addSource({ name: 'Acme', type: 'CLIENT' });
      expect(s).toMatchObject({ name: 'Acme', type: 'CLIENT' });
      expect(s.id.length).toBeGreaterThan(0);
    });

    it('rejects a duplicate source name (case-insensitive)', async () => {
      await svc.addSource({ name: 'Acme', type: 'CLIENT' });
      await expect(svc.addSource({ name: ' acme ', type: 'TEXT' })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('renames a source and deletes one', async () => {
      const s = await svc.addSource({ name: 'Acme', type: 'CLIENT' });
      const up = await svc.updateSource(s.id, { name: 'Acme Corp' });
      expect(up.name).toBe('Acme Corp');
      await svc.deleteSource(s.id);
      expect((await svc.get()).sources).toHaveLength(0);
    });

    it('updateSource on unknown id → NotFound', async () => {
      await expect(svc.updateSource('ghost', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
