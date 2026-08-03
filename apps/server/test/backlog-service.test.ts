import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Requirement } from '@po/core';
import { createRequirementService } from '../src/factory.js';
import {
  backlogXlsxBuffer,
  httpError,
  makeImportHarness,
  scriptedClient,
  KIT_PROJECT,
  type ImportHarness,
} from './aiImportKit.js';
import { cleanup, makeTmpRoot } from './helpers.js';

/**
 * todo_22 · T-304: the backlog flow end-to-end over a scripted model:
 * parse → awaiting-confirmation → confirm{target} → match → awaiting-review
 * (NOTHING written) → apply{rowIds} → populate → succeeded + report.
 */

const FILE = 'backlog.xlsx';

async function writeUpload(buffer: Buffer): Promise<string> {
  const p = path.join(os.tmpdir(), `po-backlog-test-${randomBytes(8).toString('hex')}`);
  await fs.writeFile(p, buffer);
  return p;
}

/** Deterministic snapshot of everything the import may write into the project. */
async function projectSnapshot(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, `${rel}/${e.name}`);
      else parts.push(`${rel}/${e.name}:${(await fs.readFile(p, 'utf8')).length}`);
    }
  };
  await walk(path.join(root, KIT_PROJECT, 'openspec'), 'openspec');
  try {
    parts.push(
      `dict:${await fs.readFile(path.join(root, KIT_PROJECT, 'dictionaries.json'), 'utf8')}`,
    );
  } catch {
    parts.push('dict:none');
  }
  return parts.join('\n');
}

/** The reference 5-row workbook: keys, texts, two file-provided targets. */
function workbook(): Buffer {
  return backlogXlsxBuffer([
    ['Issue key', 'Summary', 'Due date'],
    ['AB-1', 'Печать сводного отчёта по продажам', undefined],
    ['AB-2', 'Выгрузка данных в Excel', 'Q3 2027'],
    ['AB-3', 'Импорт данных из Excel', undefined],
    ['AB-4', 'Снова печать отчётов (дубль)', 'Q3 2027'],
    ['AB-5', 'Ещё одна строка без выбора', undefined],
  ]);
}

/** One valid match answer covering every row of the reference workbook. */
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
  {
    rowId: 'r4',
    businessName: 'Импорт из Excel',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Обмен данными', parentName: null },
    duplicateOf: null,
  },
  {
    rowId: 'r5',
    businessName: 'Печать отчётов из бэклога',
    type: 'FUNCTION',
    parentExisting: 'Печать отчётов',
    parentNew: null,
    duplicateOf: 'Печать отчётов',
  },
  {
    rowId: 'r6',
    businessName: 'Прочая функция',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Обмен данными', parentName: null },
    duplicateOf: null,
  },
]);

describe('T-304 · backlog import service flow', () => {
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

  it('full flow: preview → confirm(target) → review (no writes!) → apply subset → report', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const before = await projectSnapshot(root);

    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    let view = service.getView(jobId);
    expect(view.kind).toBe('backlog');
    expect(view.status).toBe('awaiting-confirmation');
    expect(view.backlogPreview).toMatchObject({
      totalRows: 5,
      fileName: FILE,
      columns: {
        keyColumn: 'A — Issue key',
        textColumn: 'B — Summary',
        targetColumn: 'C — Due date',
      },
    });
    expect(view.backlogPreview!.sampleRows.length).toBeLessThanOrEqual(5);
    expect(await projectSnapshot(root)).toBe(before); // parse writes nothing

    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);
    view = service.getView(jobId);
    expect(view.status).toBe('awaiting-review');
    const review = view.backlogReview!;
    expect(review.mappings).toHaveLength(5);
    expect(review.duplicates).toBe(1);
    expect(review.newNodes).toEqual([{ name: 'Обмен данными', parentName: null, rowCount: 3 }]);
    // Target: file-provided beats the shared confirm choice.
    expect(review.mappings.find((m) => m.rowId === 'r3')).toMatchObject({
      targetQuarter: 'Q3',
      targetYear: 2027,
      targetFromFile: true,
    });
    expect(review.mappings.find((m) => m.rowId === 'r2')).toMatchObject({
      targetQuarter: 'Q1',
      targetYear: 2027,
      targetFromFile: false,
    });
    // THE invariant (PO №1): until apply, not a single project write.
    expect(await projectSnapshot(root)).toBe(before);

    await service.apply(jobId, ['r2', 'r3', 'r4', 'r5']); // r6 deselected
    await service.waitForCompletion(jobId);
    view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.backlogReport).toMatchObject({
      rowsTotal: 5,
      rowsSelected: 4,
      deselected: 1,
      duplicatesSkipped: 1,
      created: { functions: 3, nfrs: 0, newNodes: 1, links: 3 },
    });

    const reqs = await listReqs();
    const byName = new Map(reqs.map((r) => [r.name, r]));
    const created = byName.get('Сводный отчёт по продажам')!;
    expect(created.description).toBe('Печать сводного отчёта по продажам\n\nКлюч бэклога: AB-1');
    expect(created.implemented).toBe(false);
    expect(created).toMatchObject({ targetQuarter: 'Q1', targetYear: 2027 });
    expect(created.sources).toEqual([
      { type: 'BACKLOG', name: `Бэклог: ${FILE}`, priorityId: 'default' },
    ]);
    const parentSlug = byName.get('Печать отчётов')!.slug;
    expect(created.links).toContainEqual({ type: 'CHILD_OF', targetSlug: parentSlug });

    const node = byName.get('Обмен данными')!;
    expect(node.implemented).toBe(false);
    expect(node.sources?.[0]?.type).toBe('BACKLOG');
    const exp = byName.get('Экспорт в Excel')!;
    expect(exp).toMatchObject({ targetQuarter: 'Q3', targetYear: 2027 });
    expect(exp.links).toContainEqual({ type: 'CHILD_OF', targetSlug: node.slug });
    // Duplicate row NOT created; deselected row NOT created; existing untouched.
    expect(byName.has('Печать отчётов из бэклога')).toBe(false);
    expect(byName.has('Прочая функция')).toBe(false);
    expect(byName.get('Печать отчётов')!.implemented).toBe(true);
    expect(reqs).toHaveLength(1 + 3 + 1); // pre-existing + 3 rows + 1 node
  });

  it('restart between match and apply: the pause survives as awaiting-review', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('awaiting-review');

    // «Restart»: fresh harness over the same root (new job registry).
    const harness2 = await makeImportHarness(root);
    const service2 = harness2.makeService(scriptedClient(['[]']));
    await service2.recoverInterrupted();
    const view = await service2.getViewOrHistory(jobId);
    expect(view.status).toBe('awaiting-review'); // NOT interrupted
    expect(view.kind).toBe('backlog');
    expect(view.backlogReview?.mappings).toHaveLength(5);

    await service2.apply(jobId, ['r2']);
    await service2.waitForCompletion(jobId);
    expect((await service2.getViewOrHistory(jobId)).status).toBe('succeeded');
    const reqs = await listReqs();
    expect(reqs.map((r) => r.name)).toContain('Сводный отчёт по продажам');
  });

  it('restart while awaiting-confirmation: same pause, confirm still works', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);

    const harness2 = await makeImportHarness(root);
    const service2 = harness2.makeService(scriptedClient([MATCH_ANSWER]));
    await service2.recoverInterrupted();
    const view = await service2.getViewOrHistory(jobId);
    expect(view.status).toBe('awaiting-confirmation');
    expect(view.backlogPreview?.totalRows).toBe(5);

    await service2.confirm(jobId, {});
    await service2.waitForCompletion(jobId);
    expect((await service2.getViewOrHistory(jobId)).status).toBe('awaiting-review');
  });

  it('failure mid-match (401 → CFG-02) then resume: paid batches are not re-sent', async () => {
    const client = scriptedClient([
      JSON.stringify(JSON.parse(MATCH_ANSWER).slice(0, 2)), // batch r2,r3
      httpError(401, 'bad key'), // batch r4,r5 dies fatally
      JSON.stringify(JSON.parse(MATCH_ANSWER).slice(2)), // resumed tail
    ]);
    const service = harness.makeService(client, { backlogBatch: 2 });
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);

    let view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('CFG-02');
    expect(view.error?.resumable).toBe(true);

    await service.resume(jobId);
    await service.waitForCompletion(jobId);
    view = service.getView(jobId);
    expect(view.status).toBe('awaiting-review');
    expect(view.backlogReview?.mappings).toHaveLength(5);

    // The resumed call carried ONLY the unpaid rows.
    const create = client.chat.completions.create as unknown as {
      mock: { calls: Array<[{ messages: Array<{ content: string }> }]> };
    };
    const resumedPrompts = create.mock.calls
      .slice(2) // calls made AFTER the failed run
      .map((call) => call[0].messages.map((m) => m.content).join('\n'))
      .join('\n---\n');
    expect(resumedPrompts).not.toContain('r2\t');
    expect(resumedPrompts).not.toContain('r3\t');
    expect(resumedPrompts).toContain('r4\t');
    expect(resumedPrompts).toContain('r6\t');
  });

  it('429 with instant backoff is retried transparently during match', async () => {
    const client = scriptedClient([httpError(429, 'rate limited'), MATCH_ANSWER]);
    const service = harness.makeService(client);
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, {});
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('awaiting-review');
  });

  it('cancel on the review gate: cancelled, nothing written', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const before = await projectSnapshot(root);
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, {});
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('awaiting-review');

    const view = service.cancel(jobId);
    expect(view.status).toBe('cancelled');
    expect(await projectSnapshot(root)).toBe(before);
  });

  it('repeated apply after success is rejected (409); populate is idempotent per re-run', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);
    await service.apply(jobId, ['r2', 'r3']);
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    const countAfterFirst = (await listReqs()).length;

    await expect(service.apply(jobId, ['r2'])).rejects.toThrow(/not awaiting review/);
    expect((await listReqs()).length).toBe(countAfterFirst);
  });

  it('broken upload → DATA-05 job failure (server never crashes)', async () => {
    const service = harness.makeService(scriptedClient(['[]']));
    const upload = await writeUpload(Buffer.from('вовсе не xlsx', 'utf8'));
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('DATA-05');
    expect(view.error?.resumable).toBe(false);
  });

  it('history lists the job with kind=backlog', async () => {
    const service = harness.makeService(scriptedClient([MATCH_ANSWER]));
    const upload = await writeUpload(workbook());
    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, FILE);
    await service.waitForCompletion(jobId);
    const { jobs } = await service.listJobs(KIT_PROJECT);
    const entry = jobs.find((j) => j.jobId === jobId)!;
    expect(entry.kind).toBe('backlog');
    expect(entry.status).toBe('awaiting-confirmation');
    expect(entry.resumable).toBe(false);
  });
});
