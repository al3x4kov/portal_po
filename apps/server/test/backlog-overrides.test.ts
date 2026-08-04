import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Requirement } from '@po/core';
import { createRequirementService } from '../src/factory.js';
import type { RequirementServicePort } from '../src/services/ports.js';
import type { AiImportService } from '../src/services/AiImportService.js';
import {
  backlogXlsxBuffer,
  makeImportHarness,
  scriptedClient,
  KIT_PROJECT,
  type ImportHarness,
} from './aiImportKit.js';
import { cleanup, makeTmpRoot } from './helpers.js';

/**
 * task25 · редактирование разметки на шаге выверки: overrides в apply-теле
 * мерджатся в mappings ДО populate, валидируются по реальному дереву и
 * персистятся в контрольной точке (идемпотентный повторный apply).
 */

const FILE = 'backlog.xlsx';

async function writeUpload(buffer: Buffer): Promise<string> {
  const p = path.join(os.tmpdir(), `po-task25-test-${randomBytes(8).toString('hex')}`);
  await fs.writeFile(p, buffer);
  return p;
}

function workbook(): Buffer {
  return backlogXlsxBuffer([
    ['Issue key', 'Summary', 'Due date'],
    ['AB-1', 'Печать сводного отчёта по продажам', undefined],
    ['AB-2', 'Выгрузка данных в Excel', 'Q3 2027'],
  ]);
}

const MATCH_ANSWER = JSON.stringify([
  {
    rowId: 'r2',
    businessName: 'Сводный отчёт по продажам',
    type: 'FUNCTION',
    parentExisting: 'Печать отчётов',
    parentNew: null,
    duplicateOf: null,
  },
  {
    rowId: 'r3',
    businessName: 'Экспорт в Excel',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Обмен данными', parentName: null },
    duplicateOf: null,
  },
]);

describe('task25 · backlog apply overrides', () => {
  let root: string;
  let harness: ImportHarness;

  beforeEach(async () => {
    root = await makeTmpRoot();
    harness = await makeImportHarness(root);
    await createRequirementService(
      { projectsRoot: root, now: () => new Date().toISOString() },
      KIT_PROJECT,
    ).create({
      type: 'FUNCTION',
      name: 'Печать отчётов',
      criticality: 'MEDIUM',
      implemented: true,
    });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  async function listReqs(): Promise<Requirement[]> {
    const service = createRequirementService(
      { projectsRoot: root, now: () => new Date().toISOString() },
      KIT_PROJECT,
    );
    return (await service.list()).requirements;
  }

  /** Drive a fresh job to the review gate; returns its id. */
  async function reviewedJob(service: AiImportService): Promise<string> {
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('awaiting-review');
    return jobId;
  }

  it('КП-1/3/5: бизнес-имя и срок доезжают до требования; выверка/отчёт показывают правки', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const jobId = await reviewedJob(service);

    await service.apply(jobId, ['r2'], {
      r2: {
        businessName: 'Отчёт по продажам (правка PO)',
        targetQuarter: 'Q4',
        targetYear: 2028,
      },
    });
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');

    const reqs = await listReqs();
    const byName = new Map(reqs.map((r) => [r.name, r]));
    const created = byName.get('Отчёт по продажам (правка PO)')!;
    expect(created).toBeDefined();
    expect(created).toMatchObject({ targetQuarter: 'Q4', targetYear: 2028 });
    expect(byName.has('Сводный отчёт по продажам')).toBe(false); // старое имя не создано
    // Отчёт/выверка строятся из СМЕРДЖЕННЫХ mappings.
    const mapping = view.backlogReview!.mappings.find((m) => m.rowId === 'r2')!;
    expect(mapping.businessName).toBe('Отчёт по продажам (правка PO)');
    expect(mapping).toMatchObject({ targetQuarter: 'Q4', targetYear: 2028, targetFromFile: false });
  });

  it('КП-2: переопределение на существующий узел — требование создаётся под ним', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const jobId = await reviewedJob(service);

    // r3 предлагал НОВЫЙ узел «Обмен данными»; PO выбирает существующий.
    await service.apply(jobId, ['r3'], {
      r3: { parent: { kind: 'existing', name: 'Печать отчётов' } },
    });
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    expect(service.getView(jobId).backlogReport!.created.newNodes).toBe(0);

    const reqs = await listReqs();
    const byName = new Map(reqs.map((r) => [r.name, r]));
    expect(byName.has('Обмен данными')).toBe(false); // ненужный новый узел не создан
    const parentSlug = byName.get('Печать отчётов')!.slug;
    expect(byName.get('Экспорт в Excel')!.links).toContainEqual({
      type: 'CHILD_OF',
      targetSlug: parentSlug,
    });
  });

  it('КП-2: новый узел — создан корневым; совпадение с предлагаемым узлом не дублирует его', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const jobId = await reviewedJob(service);

    await service.apply(jobId, ['r2', 'r3'], {
      // r2: свой новый корневой узел со своим именем.
      r2: { parent: { kind: 'new', name: 'Отчётность 2.0' } },
      // r3: «обмен данными» нормализуется в уже предлагаемый узел «Обмен данными».
      r3: { parent: { kind: 'new', name: 'обмен данными' } },
    });
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.backlogReport!.created.newNodes).toBe(2); // «Отчётность 2.0» + «Обмен данными»

    const reqs = await listReqs();
    const byName = new Map(reqs.map((r) => [r.name, r]));
    const custom = byName.get('Отчётность 2.0')!;
    expect(custom).toBeDefined();
    expect(custom.links ?? []).not.toContainEqual(expect.objectContaining({ type: 'CHILD_OF' })); // корневой (v1)
    expect(byName.get('Сводный отчёт по продажам')!.links).toContainEqual({
      type: 'CHILD_OF',
      targetSlug: custom.slug,
    });
    const proposed = byName.get('Обмен данными')!;
    expect(proposed).toBeDefined(); // ровно один, не «обмен данными»-дубль
    expect(byName.get('Экспорт в Excel')!.links).toContainEqual({
      type: 'CHILD_OF',
      targetSlug: proposed.slug,
    });
  });

  it('КП-4: невалидные overrides → 400 с понятным текстом, шаг выверки не ломается', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const jobId = await reviewedJob(service);
    const before = (await listReqs()).length;

    // Правка для строки вне rowIds.
    await expect(service.apply(jobId, ['r2'], { r3: { businessName: 'x' } })).rejects.toThrow(
      /«r3».*не входит в выбранные строки/,
    );
    // Правка для неизвестной строки.
    await expect(
      service.apply(jobId, ['r2', 'r99'], { r99: { businessName: 'x' } }),
    ).rejects.toThrow(/r99/);
    // Несуществующий existing-узел: 400 с rowId и именем узла.
    await expect(
      service.apply(jobId, ['r2'], { r2: { parent: { kind: 'existing', name: 'Нет такого' } } }),
    ).rejects.toThrow(/«r2».*«Нет такого».*не найден/);
    // Пустое бизнес-имя.
    await expect(service.apply(jobId, ['r2'], { r2: { businessName: '   ' } })).rejects.toThrow(
      /«r2»/,
    );
    // Год вне диапазона.
    await expect(
      service.apply(jobId, ['r2'], { r2: { targetQuarter: 'Q1', targetYear: 2019 } }),
    ).rejects.toThrow(/«r2»/);
    // Одинокий квартал (пара обязательна).
    await expect(service.apply(jobId, ['r2'], { r2: { targetQuarter: 'Q1' } })).rejects.toThrow(
      /«r2»/,
    );

    // Шаг выверки жив: ничего не записано, apply без overrides работает как раньше.
    expect(service.getView(jobId).status).toBe('awaiting-review');
    expect((await listReqs()).length).toBe(before);
    await service.apply(jobId, ['r2']);
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    expect((await listReqs()).map((r) => r.name)).toContain('Сводный отчёт по продажам');
  });

  it('КП-6: сбой populate → повторный apply с теми же overrides идемпотентен', async () => {
    let failuresLeft = 1;
    const flakyRequirements = (pid: string): RequirementServicePort => {
      const real = createRequirementService(
        { projectsRoot: root, now: () => new Date().toISOString() },
        pid,
      );
      return {
        list: real.list.bind(real),
        checkName: real.checkName.bind(real),
        update: real.update.bind(real),
        delete: real.delete.bind(real),
        create: async (input) => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('диск взорвался');
          }
          return real.create(input);
        },
      };
    };
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]), {
      makeRequirementService: flakyRequirements,
    });
    const jobId = await reviewedJob(service);

    const overrides = {
      r2: {
        businessName: 'Имя после правки',
        parent: { kind: 'new', name: 'Узел из правки' },
        targetQuarter: 'Q2',
        targetYear: 2029,
      },
    };
    await service.apply(jobId, ['r2'], overrides);
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('failed');
    // Применённые правки уже персистированы в выверке (чекпоинт до записи).
    expect(
      service.getView(jobId).backlogReview!.mappings.find((m) => m.rowId === 'r2')!.businessName,
    ).toBe('Имя после правки');

    await service.apply(jobId, ['r2'], overrides); // те же значения — идемпотентно
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');

    const reqs = await listReqs();
    const named = reqs.filter((r) => r.name.startsWith('Имя после правки'));
    expect(named.map((r) => r.name)).toEqual(['Имя после правки']); // без дублей/суффиксов
    expect(named[0]).toMatchObject({ targetQuarter: 'Q2', targetYear: 2029 });
    const nodes = reqs.filter((r) => r.name.startsWith('Узел из правки'));
    expect(nodes.map((r) => r.name)).toEqual(['Узел из правки']);
    expect(named[0]!.links).toContainEqual({ type: 'CHILD_OF', targetSlug: nodes[0]!.slug });
  });

  it('КП-6: рестарт после сбоя → resume → выверка с правками → apply без overrides', async () => {
    let failuresLeft = 1;
    const flakyRequirements = (pid: string): RequirementServicePort => {
      const real = createRequirementService(
        { projectsRoot: root, now: () => new Date().toISOString() },
        pid,
      );
      return {
        list: real.list.bind(real),
        checkName: real.checkName.bind(real),
        update: real.update.bind(real),
        delete: real.delete.bind(real),
        create: async (input) => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('диск взорвался');
          }
          return real.create(input);
        },
      };
    };
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]), {
      makeRequirementService: flakyRequirements,
    });
    const jobId = await reviewedJob(service);
    await service.apply(jobId, ['r2'], { r2: { businessName: 'Имя после правки' } });
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('failed');

    // «Рестарт»: новый реестр заданий над тем же диском.
    const harness2 = await makeImportHarness(root);
    const service2 = harness2.makeService(scriptedClient(['[]']));
    await service2.recoverInterrupted();
    await service2.resume(jobId);
    await service2.waitForCompletion(jobId);
    const view = await service2.getViewOrHistory(jobId);
    expect(view.status).toBe('awaiting-review');
    // Смердженные mappings пережили рестарт.
    expect(view.backlogReview!.mappings.find((m) => m.rowId === 'r2')!.businessName).toBe(
      'Имя после правки',
    );

    await service2.apply(jobId, ['r2']); // без overrides — значения те же
    await service2.waitForCompletion(jobId);
    expect((await service2.getViewOrHistory(jobId)).status).toBe('succeeded');
    expect((await listReqs()).map((r) => r.name)).toContain('Имя после правки');
  });
});
