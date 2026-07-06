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

  it('update({apiKey: null}) deletes the stored key (T-1001)', async () => {
    await repo.update({ apiKey: 'sk-delete-me' });
    expect((await repo.getView()).hasApiKey).toBe(true);

    const view = await repo.update({ apiKey: null });
    expect(view.hasApiKey).toBe(false);

    const cfg = await repo.read();
    expect(cfg.apiKey).toBeUndefined();
    const raw = await fs.readFile(path.join(root, AI_CONFIG_FILENAME), 'utf8');
    expect(raw).not.toContain('sk-delete-me');
  });

  it('update({apiKey: null}) keeps modelByProject and baseURL intact (T-1001)', async () => {
    await repo.update({
      apiKey: 'sk-x',
      baseURL: 'https://stub.test/v1',
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
    });
    const view = await repo.update({ apiKey: null });
    expect(view).toEqual({ baseURL: 'https://stub.test/v1', hasApiKey: false });

    const cfg = await repo.read();
    expect(cfg.modelByProject).toEqual({ Demo: 'GigaChat-2-Pro' });
    expect(cfg.baseURL).toBe('https://stub.test/v1');
  });

  it('update({apiKey: null}) on an empty config is a safe no-op (T-1001)', async () => {
    const view = await repo.update({ apiKey: null });
    expect(view).toEqual({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: false });
  });

  it("update({apiKey: ''}) still keeps the key after deletion support (T-1001)", async () => {
    await repo.update({ apiKey: 'sk-keep' });
    await repo.update({ apiKey: '' });
    expect((await repo.read()).apiKey).toBe('sk-keep');
  });

  it('read() tolerates a corrupt config file', async () => {
    await fs.writeFile(path.join(root, AI_CONFIG_FILENAME), 'not json', 'utf8');
    const cfg = await repo.read();
    expect(cfg).toEqual({ baseURL: AI_DEFAULT_BASE_URL, modelByProject: {} });
  });

  // ── todo_18: per-model preset overrides ────────────────────────────────────
  it('update() stores per-model preset OVERRIDES only (round-trip)', async () => {
    await repo.update({
      apiKey: 'k',
      modelPresets: { 'Qwen/Qwen3.6-27B': { temperature: 0.5, chunkChars: 20_000 } },
    });
    const cfg = await repo.read();
    expect(cfg.modelPresets).toEqual({
      'Qwen/Qwen3.6-27B': { temperature: 0.5, chunkChars: 20_000 },
    });
    // getView exposes the overrides, never the key.
    const view = await repo.getView();
    expect(view.modelPresets).toEqual({
      'Qwen/Qwen3.6-27B': { temperature: 0.5, chunkChars: 20_000 },
    });
    expect(view).not.toHaveProperty('apiKey');
  });

  it('update() merges preset overrides per model id', async () => {
    await repo.update({ modelPresets: { A: { temperature: 0.3 } } });
    await repo.update({ modelPresets: { B: { maxOutputTokens: 5000 } } });
    const cfg = await repo.read();
    expect(cfg.modelPresets).toEqual({
      A: { temperature: 0.3 },
      B: { maxOutputTokens: 5000 },
    });
  });

  it('update() with an empty override object resets that model to defaults (drops the key)', async () => {
    await repo.update({ modelPresets: { A: { temperature: 0.3 }, B: { topP: 0.9 } } });
    await repo.update({ modelPresets: { A: {} } });
    const cfg = await repo.read();
    expect(cfg.modelPresets).toEqual({ B: { topP: 0.9 } });
  });

  it('read()/getView() omit modelPresets entirely when none are stored', async () => {
    await repo.update({ apiKey: 'k', projectId: 'Demo', model: 'M' });
    const cfg = await repo.read();
    expect(cfg).not.toHaveProperty('modelPresets');
    const view = await repo.getView('Demo');
    expect(view).toEqual({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: true, model: 'M' });
  });

  it('read() drops invalid/empty preset entries from a hand-edited file', async () => {
    await fs.writeFile(
      path.join(root, AI_CONFIG_FILENAME),
      JSON.stringify({
        baseURL: AI_DEFAULT_BASE_URL,
        modelByProject: {},
        modelPresets: { Good: { temperature: 0.4 }, Bad: { temperature: 9 }, Empty: {} },
      }),
      'utf8',
    );
    const cfg = await repo.read();
    expect(cfg.modelPresets).toEqual({ Good: { temperature: 0.4 } });
  });
});
