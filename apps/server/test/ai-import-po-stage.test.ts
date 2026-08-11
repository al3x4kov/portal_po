import { describe, expect, it } from 'vitest';
import type { AiExtractedRequirement, AiImportResult, AiModelPreset } from '@po/core';
import { aiImportErrorFromCode, resolveModelPreset } from '@po/core';
import type { AiClient } from '../src/services/AiHubService.js';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiImportRuntime, JsonCallOutcome } from '../src/services/aiImport/types.js';
import type { ParsedPoAssign, ParsedStructure } from '../src/services/aiImportPrompt.js';
import { runPoStructureStage } from '../src/services/aiImport/poStructureStage.js';
import { PO_GROUP_SOURCE } from '../src/services/aiImport/poTaxonomy.js';

const PRESET: AiModelPreset = resolveModelPreset('gpt-test');
const STUB_CLIENT = {} as AiClient;

/** Fake runtime (mirror of ai-import-stages.test.ts): scripted AI outcomes. */
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
  const state: { failure?: { message: string; hint: string }; calls: number } = { calls: 0 };
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
    failCode: (code, overrides) => {
      const error = aiImportErrorFromCode(code, overrides);
      state.failure = { message: error.message, hint: error.hint };
      job.status = 'failed';
      job.error = error;
    },
    chat: async <T>() => {
      state.calls += 1;
      return (queue.shift() ?? { kind: 'unparsed' }) as JsonCallOutcome<T>;
    },
    checkpoint: () => {},
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

const baseInput = (extracted: AiExtractedRequirement[]) => ({
  extracted,
  archiveMap: [] as never,
  client: STUB_CLIENT,
  model: 'gpt-test',
  apiKey: 'sk',
  preset: PRESET,
  taxonomyBatch: 150,
  assignBatch: 40,
});

const taxonomyAnswer = (nodes: ParsedStructure['nodes']): JsonCallOutcome<ParsedStructure> => ({
  kind: 'ok',
  value: { nodes, droppedInvalid: 0, total: nodes.length },
});
const assignAnswer = (
  assignments: ParsedPoAssign['assignments'],
): JsonCallOutcome<ParsedPoAssign> => ({
  kind: 'ok',
  value: { assignments, droppedInvalid: 0, total: assignments.length },
});

describe('runPoStructureStage (isolated): логическое дерево «навык AI PO»', () => {
  it('счастливый путь: таксономия → раскладка → группы и карта родителей', async () => {
    const { rt, job } = harness({
      chat: [
        taxonomyAnswer([
          { type: 'FUNCTION', name: 'Доступ', parentName: null },
          { type: 'FUNCTION', name: 'Вход', parentName: 'Доступ' },
          { type: 'NFR', name: 'Качество', parentName: null },
        ]),
        assignAnswer([
          { type: 'FUNCTION', name: 'Вход по паролю', node: 'F1.1' },
          { type: 'NFR', name: 'SLA', node: 'N1' },
        ]),
      ],
    });
    const out = await runPoStructureStage(
      rt,
      baseInput([ext({ name: 'Вход по паролю' }), ext({ type: 'NFR', name: 'SLA' })]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Три группирующих узла — синтетические записи с фиксированным провенансом.
    expect(out.groups.map((g) => g.name).sort()).toEqual(['Вход', 'Доступ', 'Качество']);
    expect(out.groups.every((g) => g.source === PO_GROUP_SOURCE)).toBe(true);
    // Карта родителей: домены — корни, раздел — под доменом, требования — по узлам.
    expect(out.structureParentByKey.get('FUNCTION:доступ')).toBeNull();
    expect(out.structureParentByKey.get('FUNCTION:вход')).toBe('Доступ');
    expect(out.structureParentByKey.get('FUNCTION:вход по паролю')).toBe('Вход');
    expect(out.structureParentByKey.get('NFR:sla')).toBe('Качество');
    expect(job.progress).toBe(80);
    expect(job.stage).toBe('structure');
  });

  it('таксономия не построилась (все раунды нечитаемы) → плоско, без вызовов раскладки, job жив', async () => {
    const { rt, state } = harness({ chat: [{ kind: 'unparsed' }] });
    const out = await runPoStructureStage(rt, baseInput([ext({ name: 'X' })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.groups).toEqual([]);
    expect(out.structureParentByKey.size).toBe(0);
    expect(state.failure).toBeUndefined();
    // Один вызов таксономии; раскладка при пустой таксономии не запускается.
    expect(state.calls).toBe(1);
  });

  it('сбой батча раскладки — best-effort: его требования остаются корневыми', async () => {
    const { rt, state, logs } = harness({
      chat: [
        taxonomyAnswer([{ type: 'FUNCTION', name: 'Домен', parentName: null }]),
        { kind: 'unparsed' },
      ],
    });
    const out = await runPoStructureStage(rt, baseInput([ext({ name: 'X' })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.structureParentByKey.get('FUNCTION:x')).toBeUndefined();
    expect(out.groups.map((g) => g.name)).toEqual(['Домен']);
    expect(state.failure).toBeUndefined();
    expect(logs.some((l) => l.message.includes('останутся корневыми'))).toBe(true);
  });

  it('коллизия: извлечённое требование стало узлом дерева — синтетика не создаётся, ответ модели про него игнорируется', async () => {
    const { rt } = harness({
      chat: [
        taxonomyAnswer([
          { type: 'FUNCTION', name: 'Доступ', parentName: null },
          { type: 'FUNCTION', name: 'Вход', parentName: 'Доступ' },
        ]),
        assignAnswer([
          // Модель пытается разложить «Вход» (узел!) в другой узел — игнор.
          { type: 'FUNCTION', name: 'Вход', node: 'F1' },
          { type: 'FUNCTION', name: 'Логин', node: 'F1.1' },
        ]),
      ],
    });
    const out = await runPoStructureStage(
      rt,
      baseInput([ext({ name: 'Вход' }), ext({ name: 'Логин' })]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.groups.map((g) => g.name)).toEqual(['Доступ']); // «Вход» — не синтетика
    expect(out.structureParentByKey.get('FUNCTION:вход')).toBe('Доступ');
    expect(out.structureParentByKey.get('FUNCTION:логин')).toBe('Вход');
  });

  it('неизвестный id узла и чужой тип отбрасываются с warn, требования остаются корневыми', async () => {
    const { rt, logs } = harness({
      chat: [
        taxonomyAnswer([
          { type: 'FUNCTION', name: 'Домен', parentName: null },
          { type: 'NFR', name: 'Качество', parentName: null },
        ]),
        assignAnswer([
          { type: 'FUNCTION', name: 'X', node: 'F7.7' },
          { type: 'NFR', name: 'Y', node: 'F1' },
        ]),
      ],
    });
    const out = await runPoStructureStage(
      rt,
      baseInput([ext({ name: 'X' }), ext({ type: 'NFR', name: 'Y' })]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.structureParentByKey.has('FUNCTION:x')).toBe(false);
    expect(out.structureParentByKey.has('NFR:y')).toBe(false);
    expect(
      logs.some(
        (l) => l.message.includes('неизвестный узел: 1') && l.message.includes('чужой тип: 1'),
      ),
    ).toBe(true);
  });

  it('пустое извлечение — ни одного вызова к модели', async () => {
    const { rt, state, logs } = harness();
    const out = await runPoStructureStage(rt, baseInput([]));
    expect(out.ok).toBe(true);
    expect(state.calls).toBe(0);
    expect(logs.some((l) => l.message.includes('структурировать нечего'))).toBe(true);
  });

  it('отмена прерывает этап', async () => {
    const { rt } = harness({ cancelled: () => true });
    const out = await runPoStructureStage(rt, baseInput([ext()]));
    expect(out.ok).toBe(false);
  });
});
