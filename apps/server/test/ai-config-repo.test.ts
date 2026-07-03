import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_DEFAULT_BASE_URL } from '@po/core';
import { AI_CONFIG_FILENAME, AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { cleanup, makeTmpRoot } from './helpers.js';

describe('T-802 AiConfigRepo', () => {
  let root: string;
  let repo: AiConfigRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new AiConfigRepo(root);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('read() returns defaults when the file is absent', async () => {
    const cfg = await repo.read();
    expect(cfg).toEqual({ baseURL: AI_DEFAULT_BASE_URL, modelByProject: {} });
  });

  it('getView() reports no key and default baseURL initially', async () => {
    const view = await repo.getView('Demo');
    expect(view).toEqual({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: false });
    expect(view).not.toHaveProperty('apiKey');
  });

  it('update() persists baseURL + key + per-project model (round-trip)', async () => {
    await repo.update({
      baseURL: 'https://stub.test/v1',
      apiKey: 'sk-secret',
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
    });
    const cfg = await repo.read();
    expect(cfg).toEqual({
      baseURL: 'https://stub.test/v1',
      apiKey: 'sk-secret',
      modelByProject: { Demo: 'GigaChat-2-Pro' },
    });
  });

  it('getView() never returns the apiKey, only hasApiKey + model', async () => {
    await repo.update({ apiKey: 'sk-secret', projectId: 'Demo', model: 'GigaChat-2-Pro' });
    const view = await repo.getView('Demo');
    expect(view).toEqual({
      baseURL: AI_DEFAULT_BASE_URL,
      hasApiKey: true,
      model: 'GigaChat-2-Pro',
    });
    expect(JSON.stringify(view)).not.toContain('sk-secret');
  });

  it('update() keeps the existing key when apiKey is blank/omitted', async () => {
    await repo.update({ apiKey: 'sk-keep' });
    await repo.update({ apiKey: '', baseURL: 'https://other.test/v1' });
    await repo.update({ baseURL: 'https://third.test/v1' });
    const cfg = await repo.read();
    expect(cfg.apiKey).toBe('sk-keep');
    expect(cfg.baseURL).toBe('https://third.test/v1');
  });

  it('update() only writes a model when a projectId is present', async () => {
    await repo.update({ model: 'Orphan' });
    const cfg = await repo.read();
    expect(cfg.modelByProject).toEqual({});
  });

  it('models are per-project (different projects keep different models)', async () => {
    await repo.update({ apiKey: 'k', projectId: 'A', model: 'model-a' });
    await repo.update({ projectId: 'B', model: 'model-b' });
    expect((await repo.getView('A')).model).toBe('model-a');
    expect((await repo.getView('B')).model).toBe('model-b');
    expect((await repo.getView('C')).model).toBeUndefined();
  });

  it('read() tolerates a corrupt config file', async () => {
    await fs.writeFile(path.join(root, AI_CONFIG_FILENAME), 'not json', 'utf8');
    const cfg = await repo.read();
    expect(cfg).toEqual({ baseURL: AI_DEFAULT_BASE_URL, modelByProject: {} });
  });
});
