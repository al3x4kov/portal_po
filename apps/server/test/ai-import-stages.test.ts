import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiExtractedRequirement, AiImportResult, AiModelPreset } from '@po/core';
import { resolveModelPreset } from '@po/core';
import type { AiClient } from '../src/services/AiHubService.js';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiImportRuntime, JsonCallOutcome } from '../src/services/aiImport/types.js';
import type {
  ParsedExtraction,
  ParsedRelate,
  ParsedStructure,
} from '../src/services/aiImportPrompt.js';
import { runUnpackStage } from '../src/services/aiImport/unpackStage.js';
import { runAnalyzeStage } from '../src/services/aiImport/analyzeStage.js';
import { runStructureStage } from '../src/services/aiImport/structureStage.js';
import { runPopulateStage } from '../src/services/aiImport/populateStage.js';
import { runRelateStage } from '../src/services/aiImport/relateStage.js';
import type { AggregatedRecord } from '../src/services/aiImport/types.js';
import {
  createProjectRepo,
  createProjectService,
  createRequirementService,
  createLinkService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const PRESET: AiModelPreset = resolveModelPreset('gpt-test');

/** Fake runtime: records logs, scripts AI outcomes, exposes captured failure. */
function harness(opts: { chat?: JsonCallOutcome<unknown>[]; cancelled?: () => boolean } = {}) {
  const job: AiImportJobState = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'unpack',
    progress: 0,
    log: [],
    cancelRequested: false,
  };
  const counters: AiImportResult = {
    createdFunctions: 0,
    createdNfrs: 0,
    skippedExisting: 0,
    links: 0,
    relatesLinks: 0,
  };
  const logs: Array<{ level: string; message: string }> = [];
  const queue = [...(opts.chat ?? [])];
  const state: { failure?: { message: string; hint: string } } = {};
  const rt: AiImportRuntime = {
    job,
    counters,
    log: (level, message) => {
      logs.push({ level, message });
      job.log.push({ ts: 't', level, message });
    },
    cancelled: () => opts.cancelled?.() ?? false,
    fail: (message, hint) => {
      state.failure = { message, hint };
      job.status = 'failed';
      job.error = { message, hint };
    },
    chat: async <T>() => (queue.shift() ?? { kind: 'unparsed' }) as JsonCallOutcome<T>,
  };
  return { rt, job, counters, logs, state };
}

function ext(over: Partial<AiExtractedRequirement> = {}): AiExtractedRequirement {
  return {
    type: 'FUNCTION',
    name: 'A',
    description: 'd',
    source: 's.md',
    ...over,
  } as AiExtractedRequirement;
}

/** A never-called AI client (rt.chat is faked in isolation). */
const STUB_CLIENT = {} as AiClient;

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files))
    zip.addFile(name, Buffer.from(content, 'utf8'));
  const file = path.join(os.tmpdir(), `po-stage-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

describe('runUnpackStage (isolated)', () => {
  const archives: string[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(archives.splice(0).map((f) => fs.rm(f, { force: true }).catch(() => {})));
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  it('unpacks docs, returns files + archiveMap, ends at progress 5', async () => {
    const archive = await writeZip({ 'auth.md': '# Вход', 'perf.txt': 'fast' });
    archives.push(archive);
    const { rt, job } = harness();
    const out = await runUnpackStage(rt, { archivePath: archive, archiveBytes: 1234 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      dirs.push(out.docsDir);
      expect(out.files.sort()).toEqual(['auth.md', 'perf.txt']);
      expect(out.archiveMap).toBeTruthy();
    }
    expect(job.progress).toBe(5);
  });

  it('fails with the no-docs hint when the archive has no documentation', async () => {
    const archive = await writeZip({ 'image.bin': 'x' });
    archives.push(archive);
    const { rt, state } = harness();
    const out = await runUnpackStage(rt, { archivePath: archive, archiveBytes: 10 });
    expect(out.ok).toBe(false);
    expect(state.failure?.hint).toContain('Добавьте документацию');
    if (!out.ok && out.docsDir) dirs.push(out.docsDir);
  });
});

describe('runAnalyzeStage (isolated)', () => {
  let docsDir: string;
  beforeEach(async () => {
    docsDir = path.join(os.tmpdir(), `po-analyze-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'auth.md'), '# Вход\nПользователь входит.', 'utf8');
  });
  afterEach(async () => {
    await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
  });

  const baseInput = () => ({
    docsDir,
    files: ['auth.md'],
    archiveMap: [{ path: 'auth.md' }] as never,
    model: 'gpt-test',
    apiKey: 'sk',
    baseURL: 'http://hub',
    preset: PRESET,
    chunkChars: 10_000,
    makeAiClient: () => STUB_CLIENT,
  });

  it('collects extracted records from a parsed answer', async () => {
    const parsed: ParsedExtraction = {
      items: [ext({ name: 'Вход' }), ext({ type: 'NFR', name: 'Скорость' })],
      droppedNoSource: 0,
      droppedInvalid: 0,
    };
    const { rt } = harness({ chat: [{ kind: 'ok', value: parsed }] });
    const out = await runAnalyzeStage(rt, baseInput());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.extracted.map((r) => r.name)).toEqual(['Вход', 'Скорость']);
      expect(out.client).toBe(STUB_CLIENT);
    }
  });

  it('fails the job with the upstream hint on an upstream error', async () => {
    const { rt, state } = harness({ chat: [{ kind: 'upstream', error: new Error('boom sk') }] });
    const out = await runAnalyzeStage(rt, baseInput());
    expect(out.ok).toBe(false);
    expect(state.failure?.message).toContain('AI Hub');
    expect(state.failure?.message).not.toContain('sk-'); // sanitized
  });

  it('fails with the unparseable hint when no answer parsed', async () => {
    const { rt, state } = harness({ chat: [{ kind: 'unparsed' }] });
    const out = await runAnalyzeStage(rt, baseInput());
    expect(out.ok).toBe(false);
    expect(state.failure?.hint).toContain('другую модель');
  });

  it('stops on cancel before the AI call', async () => {
    const { rt } = harness({ cancelled: () => true });
    const out = await runAnalyzeStage(rt, baseInput());
    expect(out.ok).toBe(false);
  });
});

describe('runStructureStage (isolated)', () => {
  const baseInput = (extracted: AiExtractedRequirement[]) => ({
    extracted,
    archiveMap: [] as never,
    client: STUB_CLIENT,
    model: 'gpt-test',
    apiKey: 'sk',
    preset: PRESET,
    structureBatch: 50,
  });

  it('builds the parent map from the structure answer', async () => {
    const parsed: ParsedStructure = {
      nodes: [
        { type: 'FUNCTION', name: 'Parent', parentName: null },
        { type: 'FUNCTION', name: 'Child', parentName: 'Parent' },
      ],
      droppedInvalid: 0,
      total: 2,
    };
    const { rt } = harness({ chat: [{ kind: 'ok', value: parsed }] });
    const out = await runStructureStage(
      rt,
      baseInput([ext({ name: 'Parent' }), ext({ name: 'Child' })]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.structureParentByKey.get('FUNCTION:parent')).toBeNull();
      expect(out.structureParentByKey.get('FUNCTION:child')).toBe('Parent');
    }
  });

  it('does not fail the job when a batch answer is unparseable (records stay roots)', async () => {
    const { rt, state } = harness({ chat: [{ kind: 'unparsed' }] });
    const out = await runStructureStage(rt, baseInput([ext({ name: 'X' })]));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.structureParentByKey.size).toBe(0);
    expect(state.failure).toBeUndefined();
  });

  it('makes no AI call when nothing was extracted', async () => {
    const { rt, logs } = harness();
    const out = await runStructureStage(rt, baseInput([]));
    expect(out.ok).toBe(true);
    expect(logs.some((l) => l.message.includes('Структурировать нечего'))).toBe(true);
  });
});

describe('runPopulateStage and runRelateStage (isolated, real services)', () => {
  let root: string;
  let ctx: ServiceContext;
  const PROJECT = 'Demo';

  beforeEach(async () => {
    root = await makeTmpRoot();
    ctx = { projectsRoot: root, now: fixedNow };
    await createProjectService(ctx).create(PROJECT);
    void createProjectRepo(ctx);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const agg = (
    record: AiExtractedRequirement,
    parentKey?: string,
    parentName?: string,
  ): AggregatedRecord => ({
    record,
    parentKey,
    parentName,
  });

  it('creates requirements and the resolved CHILD_OF hierarchy', async () => {
    const { rt, counters } = harness();
    const requirementService = createRequirementService(ctx, PROJECT);
    const linkService = createLinkService(ctx, PROJECT);
    const out = await runPopulateStage(rt, {
      aggregated: [
        agg(ext({ name: 'Parent' })),
        agg(ext({ name: 'Child' }), 'FUNCTION:parent', 'Parent'),
      ],
      existing: [],
      requirementService,
      linkService,
    });
    expect(out.ok).toBe(true);
    expect(counters.createdFunctions).toBe(2);
    expect(counters.links).toBe(1);
    const { requirements } = await requirementService.list();
    const child = requirements.find((r) => r.name === 'Child')!;
    expect(child.links.some((l) => l.type === 'CHILD_OF')).toBe(true);
  });

  it('skips an existing requirement without duplicating it', async () => {
    const requirementService = createRequirementService(ctx, PROJECT);
    const linkService = createLinkService(ctx, PROJECT);
    await requirementService.create({
      type: 'FUNCTION',
      name: 'Parent',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const { requirements: existing } = await requirementService.list();
    const { rt, counters } = harness();
    const out = await runPopulateStage(rt, {
      aggregated: [agg(ext({ name: 'Parent' }))],
      existing,
      requirementService,
      linkService,
    });
    expect(out.ok).toBe(true);
    expect(counters.skippedExisting).toBe(1);
    expect(counters.createdFunctions).toBe(0);
  });

  it('creates RELATES_TO links from an NFR to its explicit related functions', async () => {
    const requirementService = createRequirementService(ctx, PROJECT);
    const linkService = createLinkService(ctx, PROJECT);
    const { rt, counters } = harness();
    const out = await runPopulateStage(rt, {
      aggregated: [
        agg(ext({ name: 'Вход' })),
        agg(ext({ type: 'NFR', name: 'Скорость', relatedFunctions: ['Вход'] })),
      ],
      existing: [],
      requirementService,
      linkService,
    });
    expect(out.ok).toBe(true);
    expect(counters.relatesLinks).toBe(1);
  });

  it('relate stage creates RELATES_TO for a scripted NFR→FUNCTION pair', async () => {
    const requirementService = createRequirementService(ctx, PROJECT);
    const linkService = createLinkService(ctx, PROJECT);
    const fn = await requirementService.create({
      type: 'FUNCTION',
      name: 'Вход',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const nfr = await requirementService.create({
      type: 'NFR',
      name: 'Скорость',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const parsed: ParsedRelate = {
      pairs: [{ nfr: nfr.slug, function: fn.slug }],
      droppedInvalid: 0,
      total: 1,
    };
    const { rt, job } = harness({ chat: [{ kind: 'ok', value: parsed }] });
    const stopped = await runRelateStage(rt, {
      client: STUB_CLIENT,
      model: 'gpt-test',
      preset: PRESET,
      apiKey: 'sk',
      requirementService,
      linkService,
    });
    expect(stopped).toBe(false);
    expect(job.relate).toEqual({ status: 'done', created: 1 });
    const { requirements } = await requirementService.list();
    const updated = requirements.find((r) => r.slug === nfr.slug)!;
    expect(updated.links.some((l) => l.type === 'RELATES_TO' && l.targetSlug === fn.slug)).toBe(
      true,
    );
  });

  it('relate stage never fails the import on an upstream error (skipped)', async () => {
    const requirementService = createRequirementService(ctx, PROJECT);
    const linkService = createLinkService(ctx, PROJECT);
    await requirementService.create({
      type: 'FUNCTION',
      name: 'Вход',
      criticality: 'MEDIUM',
      implemented: true,
    });
    await requirementService.create({
      type: 'NFR',
      name: 'Скорость',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const { rt, job } = harness({ chat: [{ kind: 'upstream', error: new Error('down') }] });
    const stopped = await runRelateStage(rt, {
      client: STUB_CLIENT,
      model: 'gpt-test',
      preset: PRESET,
      apiKey: 'sk',
      requirementService,
      linkService,
    });
    expect(stopped).toBe(false);
    expect(job.relate?.status).toBe('skipped');
  });
});
