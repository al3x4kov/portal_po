import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUIREMENT_FOLDER } from '@po/core';
import { createProjectService } from '../src/factory.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import {
  FsDictionariesRepo,
  DEFAULT_PRIORITY_ID,
  DICTIONARIES_FILENAME,
} from '../src/repositories/FsDictionariesRepo.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('T-113 project create seeds dictionaries.json', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('writes a default dictionaries.json when a project is created', async () => {
    const svc = createProjectService({ projectsRoot: root, now: fixedNow });
    await svc.create('P');
    const raw = await fs.readFile(path.join(root, 'P', DICTIONARIES_FILENAME), 'utf8');
    const dict = JSON.parse(raw);
    expect(dict.priorities).toHaveLength(1);
    expect(dict.priorities[0].name).toBe('Квартальная цель');
    expect(dict.sources).toEqual([]);
  });
});

describe('T-105 legacy source migrated on read via FsRequirementRepo', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('parses a legacy .md (source, no sources) into a TEXT source with the default priorityId', async () => {
    const svc = createProjectService({ projectsRoot: root, now: fixedNow });
    await svc.create('P');
    // Hand-write a legacy requirement file with the deprecated `source` field.
    const dir = path.join(root, 'P', 'openspec', 'specs', REQUIREMENT_FOLDER.FUNCTION);
    const md = [
      '### Requirement: Legacy',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '- source: АС21',
    ].join('\n');
    await fs.writeFile(path.join(dir, 'legacy.md'), md, 'utf8');

    const repo = new FsRequirementRepo(root, 'P', {
      dictionaries: new FsDictionariesRepo(root, 'P'),
    });
    const { requirements } = await repo.loadAll();
    const legacy = requirements.find((r) => r.slug === 'legacy')!;
    expect(legacy.source).toBeUndefined();
    expect(legacy.sources).toEqual([
      { type: 'TEXT', name: 'АС21', priorityId: DEFAULT_PRIORITY_ID },
    ]);
  });
});
