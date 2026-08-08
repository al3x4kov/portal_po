import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/lib/errors.js';
import { createRequirementService } from '../src/factory.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * Двухзонная выверка дублей docs-импорта: конвейер останавливается на
 * REST-гейте `awaiting-review` ДВАЖДЫ — зона 1 (дубли сгенерированных между
 * собой, группы `groupId`) и зона 2 (дубли с уже существующими в проекте,
 * `duplicateOf`). Запись в проект происходит только после апрува зоны 2;
 * пауза переживает перезапуск сервера тем же статусом.
 */

const PRESET_FREE = { estimateThresholdTokens: null };

/** Extraction answer: two near-duplicates, one distinct FT and one NFR. */
const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Быстрый фильтр по статусу',
    description: 'Фильтрация списка по статусу.',
    source: 'doc.md § 1',
  },
  {
    type: 'FUNCTION',
    name: 'Быстрый фильтр по статусам',
    description: 'Фильтрация списка по статусам (расширенная).',
    source: 'doc.md § 2',
  },
  {
    type: 'FUNCTION',
    name: 'Экспорт проекта',
    description: 'Выгрузка проекта в архив.',
    source: 'doc.md § 3',
  },
  {
    type: 'NFR',
    name: 'Время отклика',
    description: 'Отклик до 200 мс.',
    source: 'doc.md § 4',
    relatedFunctions: ['Экспорт проекта'],
  },
]);

/** Model confirms the near-pair as a semantic duplicate (→ группа, не merge). */
const PAIR_CONFIRM = JSON.stringify([{ pair: 1, duplicate: true }]);

/** Structure: «Экспорт проекта» под первым фильтром, остальные — корни. */
const STRUCTURE = JSON.stringify([
  { type: 'FUNCTION', name: 'Быстрый фильтр по статусу', parentName: null },
  { type: 'FUNCTION', name: 'Быстрый фильтр по статусам', parentName: null },
  { type: 'FUNCTION', name: 'Экспорт проекта', parentName: 'Быстрый фильтр по статусу' },
  { type: 'NFR', name: 'Время отклика', parentName: null },
]);

describe('Двухзонная выверка docs-импорта (интеграция)', () => {
  let root: string;
  let h: ImportHarness;
  const archives: string[] = [];

  beforeEach(async () => {
    root = await makeTmpRoot();
    h = await makeImportHarness(root);
    await h.setPreset(PRESET_FREE);
  });
  afterEach(async () => {
    await Promise.all(archives.splice(0).map((f) => fs.rm(f, { force: true }).catch(() => {})));
    await cleanup(root);
  });

  async function startToZone1(service: ReturnType<ImportHarness['makeService']>) {
    const archive = await writeZipArchive({ 'doc.md': 'Документация о фильтрах и экспорте.' });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);
    return jobId;
  }

  it('золотой путь: зона 1 (группы) → зона 2 (duplicateOf) → запись только выбранного', async () => {
    // Существующие требования проекта для зоны 2: точный и fuzzy-дубль.
    const reqService = createRequirementService(h.ctx, KIT_PROJECT);
    await reqService.create({
      type: 'FUNCTION',
      name: 'Быстрый фильтр по статусу',
      criticality: 'MEDIUM',
      implemented: true,
    });
    await reqService.create({
      type: 'FUNCTION',
      name: 'Экспорт проектов',
      criticality: 'MEDIUM',
      implemented: true,
    });

    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);

    // ── Зона 1: пауза без записи, группы смысловых дублей видны ──
    const zone1 = service.getView(jobId);
    expect(zone1.status).toBe('awaiting-review');
    expect(zone1.docsReview?.phase).toBe('self');
    expect(zone1.docsReview?.items).toHaveLength(4);
    expect(zone1.docsReview?.groupCount).toBe(1);
    const items = zone1.docsReview!.items;
    const [a1, a2] = items.filter((i) => i.groupId !== undefined);
    expect(a1?.record.name).toBe('Быстрый фильтр по статусу');
    expect(a2?.record.name).toBe('Быстрый фильтр по статусам');
    expect(a1?.groupId).toBe(a2?.groupId);
    // Предлагаемое место в дереве видно на выверке.
    const exportItem = items.find((i) => i.record.name === 'Экспорт проекта')!;
    expect(exportItem.parentName).toBe('Быстрый фильтр по статусу');
    // Ничего не записано до апрува.
    expect((await reqService.list()).requirements).toHaveLength(2);

    // ── Апрув зоны 1: оставляем один из пары дублей + остальное ──
    const keepZone1 = items.filter((i) => i.id !== a2!.id).map((i) => i.id);
    const zone2 = await service.applyDocsReview(jobId, 'self', keepZone1);
    expect(zone2.status).toBe('awaiting-review');
    expect(zone2.docsReview?.phase).toBe('existing');
    expect(zone2.docsReview?.items).toHaveLength(3);
    expect(zone2.docsReview?.duplicateCount).toBe(2);
    const z2items = zone2.docsReview!.items;
    const exact = z2items.find((i) => i.record.name === 'Быстрый фильтр по статусу')!;
    expect(exact.duplicateOf).toBe('Быстрый фильтр по статусу');
    expect(exact.duplicateSimilarity).toBe(1);
    const fuzzy = z2items.find((i) => i.record.name === 'Экспорт проекта')!;
    expect(fuzzy.duplicateOf).toBe('Экспорт проектов');
    expect(fuzzy.duplicateSimilarity).toBeLessThan(1);
    const nfr = z2items.find((i) => i.record.type === 'NFR')!;
    expect(nfr.duplicateOf).toBeUndefined();
    // По-прежнему ничего не записано.
    expect((await reqService.list()).requirements).toHaveLength(2);

    // ── Апрув зоны 2: записываем fuzzy-дубль (осознанно) и НФТ ──
    await service.applyDocsReview(jobId, 'existing', [fuzzy.id, nfr.id]);
    await service.waitForCompletion(jobId);

    const done = service.getView(jobId);
    expect(done.status).toBe('succeeded');
    expect(done.result?.createdFunctions).toBe(1);
    expect(done.result?.createdNfrs).toBe(1);
    const { requirements } = await reqService.list();
    expect(requirements.map((r) => r.name).sort()).toEqual([
      'Быстрый фильтр по статусу',
      'Время отклика',
      'Экспорт проекта',
      'Экспорт проектов',
    ]);
    // relatedFunctions НФТ дошли до RELATES_TO.
    const created = requirements.find((r) => r.name === 'Время отклика')!;
    expect(created.links.some((l) => l.type === 'RELATES_TO')).toBe(true);
  });

  it('контракт гейта: чужая фаза → 409; неизвестный id → 400; пустая зона 1 завершает без записи', async () => {
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);

    await expect(service.applyDocsReview(jobId, 'existing', ['d1'])).rejects.toThrow(ConflictError);
    await expect(service.applyDocsReview(jobId, 'self', ['nope'])).rejects.toThrow(
      /Неизвестные записи/,
    );

    // Пустой выбор зоны 1 — законное «ничего не включать».
    const view = await service.applyDocsReview(jobId, 'self', []);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(0);
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    expect(requirements).toHaveLength(0);
  });

  it('пауза выверки переживает перезапуск сервера тем же статусом (REST-гейт)', async () => {
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);
    expect(service.getView(jobId).status).toBe('awaiting-review');

    // «Рестарт»: новый харнес над тем же корнем (свежий реестр джоб).
    const h2 = await makeImportHarness(root);
    const service2 = h2.makeService(client);
    await service2.recoverInterrupted();

    const restored = await service2.getViewOrHistory(jobId);
    expect(restored.status).toBe('awaiting-review');
    expect(restored.docsReview?.phase).toBe('self');
    expect(restored.docsReview?.items).toHaveLength(4);

    // Гейты применимы на новом инстансе — контекст восстановлен с диска.
    await approveDocsReview(service2, jobId);
    expect(service2.getView(jobId).status).toBe('succeeded');
    const { requirements } = await createRequirementService(h2.ctx, KIT_PROJECT).list();
    // Пара смысловых дублей одобрена целиком — обе записи созданы осознанно.
    expect(requirements).toHaveLength(4);
  });

  it('гонка apply/cancel: отмена во время анализа зоны 2 не даёт записать (409)', async () => {
    // Отмена прилетает В СЕРЕДИНЕ applyDocsReview — пока сервис ждёт список
    // требований проекта. Гейт обязан перепровериться после await, иначе
    // отменённая джоба запустила бы populate.
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    let cancelOnNextList = false;
    let jobIdRef: string | undefined;
    const service: ReturnType<ImportHarness['makeService']> = h.makeService(client, {
      makeRequirementService: (pid) => {
        const real = createRequirementService(h.ctx, pid);
        return {
          list: async () => {
            const out = await real.list();
            if (cancelOnNextList && jobIdRef) {
              cancelOnNextList = false;
              service.cancel(jobIdRef);
            }
            return out;
          },
          checkName: (...args) => real.checkName(...args),
          create: (input) => real.create(input),
          update: (slug, input) => real.update(slug, input),
          delete: (slug, opts) => real.delete(slug, opts),
        };
      },
    });
    const jobId = await startToZone1(service);
    jobIdRef = jobId;
    const items = service.getView(jobId).docsReview!.items;

    cancelOnNextList = true;
    await expect(
      service.applyDocsReview(
        jobId,
        'self',
        items.map((i) => i.id),
      ),
    ).rejects.toThrow(ConflictError);
    expect(service.getView(jobId).status).toBe('cancelled');
    expect((await createRequirementService(h.ctx, KIT_PROJECT).list()).requirements).toHaveLength(
      0,
    );
  });

  it('двойной сабмит зоны 2: побеждает ровно один apply, второй — 409, без дублей', async () => {
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);
    const zone1 = service.getView(jobId).docsReview!;
    await service.applyDocsReview(
      jobId,
      'self',
      zone1.items.map((i) => i.id),
    );
    const zone2 = service.getView(jobId).docsReview!;
    const ids = zone2.items.map((i) => i.id);

    const [first, second] = await Promise.allSettled([
      service.applyDocsReview(jobId, 'existing', ids),
      service.applyDocsReview(jobId, 'existing', ids),
    ]);
    const outcomes = [first!, second!];
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);

    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    // 3 ФТ + 1 НФТ из выгрузки — ровно по одному, без дублей от гонки.
    expect(requirements).toHaveLength(4);
  });

  it('родитель отсеян на выверке: ребёнок создаётся в корне с явным warn', async () => {
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);
    const items = service.getView(jobId).docsReview!.items;
    await service.applyDocsReview(
      jobId,
      'self',
      items.map((i) => i.id),
    );

    // Зона 2: отсеиваем родителя «Быстрый фильтр по статусу», ребёнка оставляем.
    const zone2 = service.getView(jobId).docsReview!;
    const parent = zone2.items.find((i) => i.record.name === 'Быстрый фильтр по статусу')!;
    const keep = zone2.items.filter((i) => i.id !== parent.id).map((i) => i.id);
    await service.applyDocsReview(jobId, 'existing', keep);
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // Обещанное «под родителем» место исчезло не молча — есть явный warn.
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('не выбран на выверке')),
    ).toBe(true);
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    const child = requirements.find((r) => r.name === 'Экспорт проекта')!;
    expect(child.links.some((l) => l.type === 'CHILD_OF')).toBe(false); // корень
    expect(view.result?.links).toBe(0);
  });

  it('отмена на гейте выверки: ничего не записано, статус cancelled, resume возвращает гейт', async () => {
    const client = scriptedClient([EXTRACTION, PAIR_CONFIRM, STRUCTURE]);
    const service = h.makeService(client);
    const jobId = await startToZone1(service);

    const cancelled = service.cancel(jobId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.log.some((l) => l.message.includes('в проект ничего не записано'))).toBe(true);
    expect((await createRequirementService(h.ctx, KIT_PROJECT).list()).requirements).toHaveLength(
      0,
    );

    // «Продолжить» возвращает ту же паузу выверки без повторных AI-вызовов.
    await service.resume(jobId);
    const reopened = service.getView(jobId);
    expect(reopened.status).toBe('awaiting-review');
    expect(reopened.docsReview?.phase).toBe('self');
  });
});
