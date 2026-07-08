import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import {
  FsDictionariesRepo,
  DICTIONARIES_FILENAME,
} from '../src/repositories/FsDictionariesRepo.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('T-110 FsDictionariesRepo', () => {
  let root: string;
  let projectRepo: FsProjectRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    projectRepo = new FsProjectRepo(root);
    await projectRepo.create('P', fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('seeds a default dictionary with one "Квартальная цель" priority', async () => {
    const repo = new FsDictionariesRepo(root, 'P');
    const seeded = await repo.seedDefault();
    expect(seeded.sources).toEqual([]);
    expect(seeded.priorities).toHaveLength(1);
    expect(seeded.priorities[0]).toMatchObject({
      name: 'Квартальная цель',
      color: 'amber',
      order: 0,
    });
    expect(seeded.priorities[0]!.id.length).toBeGreaterThan(0);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(root, 'P', DICTIONARIES_FILENAME), 'utf8'),
    );
    expect(onDisk).toEqual(seeded);
  });

  it('read returns a default (unpersisted) shape when the file is missing', async () => {
    const repo = new FsDictionariesRepo(root, 'P');
    const dict = await repo.read();
    expect(dict.priorities).toHaveLength(1);
    expect(dict.priorities[0]!.name).toBe('Квартальная цель');
    // read() must not create the file
    await expect(fs.stat(path.join(root, 'P', DICTIONARIES_FILENAME))).rejects.toBeTruthy();
  });

  it('write persists atomically and read round-trips', async () => {
    const repo = new FsDictionariesRepo(root, 'P');
    const dict = {
      priorities: [{ id: 'p1', name: 'A', color: 'red' as const, order: 0 }],
      sources: [{ id: 's1', name: 'Acme', type: 'CLIENT' as const }],
    };
    await repo.write(dict);
    expect(await repo.read()).toEqual(dict);
  });
});
