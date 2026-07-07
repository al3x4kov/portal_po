import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiImportService, type ServiceContext } from '../src/factory.js';
import { AiImportService } from '../src/services/AiImportService.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('BE-6 createAiImportService composition root', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await cleanup(root);
  });

  function ctx(): ServiceContext {
    return { projectsRoot: root, now: fixedNow };
  }

  it('assembles a working AiImportService from a ServiceContext + jobs registry', () => {
    const jobs = new AiImportJobs(fixedNow);
    const service = createAiImportService(ctx(), jobs);
    expect(service).toBeInstanceOf(AiImportService);
  });

  it('wires projectExists so start() rejects an unknown project with NOT_FOUND', async () => {
    const jobs = new AiImportJobs(fixedNow);
    const service = createAiImportService(ctx(), jobs);
    // No mock client needed: the project-existence precondition fails first.
    await expect(service.start('nope', '/tmp/none.zip')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
