import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_OPTIONAL_FIELDS, type Requirement } from '@po/core';
import { createProjectService } from '../src/factory.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { FsDictionariesRepo } from '../src/repositories/FsDictionariesRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import type { ArchiveFormat, ExportResult } from '../src/repositories/ArchiveRepo.js';

/**
 * Полнота экспорта: НИЧЕГО не теряется на пути «проект → архив → импорт».
 *
 * Проверяется на «максимально заполненном» проекте (все опциональные поля
 * требования, RICE и сроки внутри источников, сценарии, справочная информация,
 * связи всех типов, AI-происхождение, кастомные справочники) и на ВСЕХ трёх
 * путях сборки архива:
 *   1. `export()` без маски полей — побайтовое копирование каталога;
 *   2. `export()` с полной маской — путь UI: экран экспорта всегда присылает
 *      список включённых полей, поэтому архив пересобирается через
 *      core `serialize()`, и любая асимметрия serialize/parse обернулась бы
 *      потерей данных;
 *   3. `exportSelected()` — выборочный экспорт (обе ветки: с маской и без).
 */

const ALL_FIELDS = [...EXPORT_OPTIONAL_FIELDS];

async function bodyToFile(result: ExportResult, dir: string): Promise<string> {
  const ext = result.filename.endsWith('.zip') ? 'zip' : 'tar.gz';
  const file = path.join(dir, `out-${randomBytes(4).toString('hex')}.${ext}`);
  if (Buffer.isBuffer(result.body)) {
    await fs.writeFile(file, result.body);
  } else {
    await pipeline(result.body as Readable, createWriteStream(file));
  }
  return file;
}

/** Требования, отсортированные по slug — для сравнения без учёта порядка чтения. */
function bySlug(reqs: Requirement[]): Requirement[] {
  return [...reqs].sort((a, b) => a.slug.localeCompare(b.slug));
}

describe('Полнота экспорта: round-trip без потери данных', () => {
  let root: string;
  let svc: ReturnType<typeof createProjectService>;
  let scratch: string;
  let sourceSlugs: string[];

  beforeEach(async () => {
    root = await makeTmpRoot();
    svc = createProjectService({ projectsRoot: root, now: fixedNow });
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-lossless-'));
    sourceSlugs = await seedRichProject();
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  /** Проект, в котором заполнено всё, что вообще умеет хранить требование. */
  async function seedRichProject(): Promise<string[]> {
    await svc.create('Rich');
    const repo = new FsRequirementRepo(root, 'Rich');
    const reqs = new RequirementService(repo, fixedNow);
    const links = new LinkService(repo, fixedNow);
    const dict = new FsDictionariesRepo(root, 'Rich');

    // Кастомные справочники: приоритеты и источники проекта.
    const base = await dict.read();
    await dict.write({
      ...base,
      priorities: [
        ...base.priorities,
        { id: 'p-strategy', name: 'Стратегическая ставка', color: 'red', order: 99 },
      ],
      sources: [
        ...base.sources,
        { id: 's-cpo', name: 'CPO', type: 'STAKEHOLDER', color: 'violet' },
      ],
    });
    const priorityId = (await dict.read()).priorities[0]!.id;

    const parent = await reqs.create({
      type: 'FUNCTION',
      name: 'Лента',
      criticality: 'BLOCKER',
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
      releaseDate: '2026-09-30',
      description:
        'Первый абзац описания.\n\nВторой абзац: **markdown**, список:\n- пункт 1\n- пункт 2',
      infoItems: [
        { type: 'Ссылка', value: 'https://example.test/spec' },
        { type: 'Регламент', value: 'РГ-17 от 2026-01-09' },
      ],
      sources: [
        {
          type: 'STAKEHOLDER',
          name: 'CPO',
          priorityId: 'p-strategy',
          rice: { reach: 5, impact: 3, confidence: 1, effort: 2 },
          targetQuarter: 'Q3',
          targetYear: 2026,
          targetDate: '2026-09-15',
        },
        { type: 'STANDARD', name: 'ПАО-2026', priorityId },
      ],
      origin: 'AI_DOCS',
    });

    const child = await reqs.create({
      type: 'FUNCTION',
      name: 'Алгоритмическая лента',
      criticality: 'HIGH',
      implemented: true,
      description: 'Ранжирование ленты «Для вас».',
      source: 'Легаси-источник строкой',
    });

    const nfr = await reqs.create({
      type: 'NFR',
      name: 'Доступность 99.95%',
      criticality: 'CRITICAL',
      implemented: true,
      infoItems: [{ type: 'SLA', value: '99.95% в месяц' }],
    });

    // Связи всех типов, включая реципрокные пары.
    await links.create({ sourceSlug: parent.slug, type: 'PARENT_OF', targetSlug: child.slug });
    await links.create({ sourceSlug: child.slug, type: 'BLOCKED_BY', targetSlug: nfr.slug });
    await links.create({ sourceSlug: parent.slug, type: 'RELATES_TO', targetSlug: nfr.slug });

    // Флаг ревью AI-требования проставляется отдельным обновлением (task26).
    // Update — полная замена, поэтому передаём весь набор полей: иначе
    // описание/источники/справочная информация были бы затёрты.
    const stored = (await repo.loadAll()).requirements.find((r) => r.slug === parent.slug)!;
    await reqs.update(parent.slug, {
      name: stored.name,
      criticality: stored.criticality,
      implemented: stored.implemented,
      ...(stored.targetQuarter ? { targetQuarter: stored.targetQuarter } : {}),
      ...(stored.targetYear !== undefined ? { targetYear: stored.targetYear } : {}),
      ...(stored.releaseDate ? { releaseDate: stored.releaseDate } : {}),
      ...(stored.description ? { description: stored.description } : {}),
      ...(stored.infoItems ? { infoItems: stored.infoItems } : {}),
      ...(stored.sources ? { sources: stored.sources } : {}),
      aiValidated: true,
    });

    return [parent.slug, child.slug, nfr.slug].sort();
  }

  async function loadProject(id: string): Promise<Requirement[]> {
    const { requirements, broken } = await new FsRequirementRepo(root, id).loadAll();
    expect(broken).toEqual([]);
    return bySlug(requirements);
  }

  /** Экспорт → импорт в новый проект → его требования. */
  async function roundTrip(
    exported: ExportResult,
    name: string,
  ): Promise<{ id: string; requirements: Requirement[] }> {
    const file = await bodyToFile(exported, scratch);
    const imported = await svc.import(file, name);
    return { id: imported.id, requirements: await loadProject(imported.id) };
  }

  it('исходный проект действительно заполнен всеми полями (защита самого теста)', async () => {
    const [lenta] = await loadProject('Rich').then((rs) => rs.filter((r) => r.name === 'Лента'));
    expect(lenta).toBeDefined();
    expect(lenta!.description).toContain('markdown');
    expect(lenta!.infoItems).toHaveLength(2);
    expect(lenta!.sources?.[0]?.rice).toEqual({ reach: 5, impact: 3, confidence: 1, effort: 2 });
    expect(lenta!.sources?.[0]?.targetDate).toBe('2026-09-15');
    expect(lenta!.releaseDate).toBe('2026-09-30');
    expect(lenta!.origin).toBe('AI_DOCS');
    expect(lenta!.aiValidated).toBe(true);
    expect(lenta!.links).toHaveLength(2);
  });

  for (const format of ['zip', 'targz'] as ArchiveFormat[]) {
    it(`${format}: полный экспорт БЕЗ маски полей возвращает требования поле-в-поле`, async () => {
      const before = await loadProject('Rich');
      const { requirements } = await roundTrip(
        await svc.export('Rich', format),
        `Copy verbatim ${format}`,
      );
      expect(requirements).toEqual(before);
    });

    it(`${format}: экспорт со ВСЕМИ полями (путь UI) не теряет ни одного поля`, async () => {
      const before = await loadProject('Rich');
      const { requirements } = await roundTrip(
        await svc.export('Rich', format, ALL_FIELDS),
        `Copy masked ${format}`,
      );
      expect(requirements).toEqual(before);
    });

    it(`${format}: выборочный экспорт всех требований равен полному`, async () => {
      const before = await loadProject('Rich');
      const noMask = await roundTrip(
        await svc.exportSelected('Rich', sourceSlugs, format),
        `Copy selected ${format}`,
      );
      expect(noMask.requirements).toEqual(before);

      const masked = await roundTrip(
        await svc.exportSelected('Rich', sourceSlugs, format, ALL_FIELDS),
        `Copy selected masked ${format}`,
      );
      expect(masked.requirements).toEqual(before);
    });

    it(`${format}: справочники проекта переживают экспорт и импорт`, async () => {
      const before = await new FsDictionariesRepo(root, 'Rich').read();
      for (const [suffix, exported] of [
        ['verbatim', await svc.export('Rich', format)],
        ['masked', await svc.export('Rich', format, ALL_FIELDS)],
        ['selected', await svc.exportSelected('Rich', sourceSlugs, format)],
        ['selected-masked', await svc.exportSelected('Rich', sourceSlugs, format, ALL_FIELDS)],
      ] as const) {
        const { id } = await roundTrip(exported, `Dict ${suffix} ${format}`);
        const after = await new FsDictionariesRepo(root, id).read();
        expect(after, `dictionaries lost on ${suffix}/${format}`).toEqual(before);
      }
    });
  }

  it('zip-архив содержит манифест, справочники и все .md требований', async () => {
    const zip = new AdmZip((await svc.export('Rich', 'zip')).body as Buffer);
    const names = zip
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.split(path.sep).join('/'))
      .sort();
    expect(names).toContain('openspec/project.md');
    expect(names).toContain('dictionaries.json');
    for (const slug of sourceSlugs) {
      expect(
        names.some((n) => n.endsWith(`/${slug}.md`)),
        `missing ${slug}.md`,
      ).toBe(true);
    }
    // Служебное состояние AI-импортов наружу не уходит (todo_20 T-211).
    expect(names.some((n) => n.includes('.ai-jobs'))).toBe(false);
  });

  it('маскированный архив несёт тот же набор файлов, что и побайтовая копия', async () => {
    const listOf = (buf: Buffer): string[] =>
      new AdmZip(buf)
        .getEntries()
        .filter((e) => !e.isDirectory)
        .map((e) => e.entryName.split(path.sep).join('/'))
        .sort();
    const verbatim = listOf((await svc.export('Rich', 'zip')).body as Buffer);
    const masked = listOf((await svc.export('Rich', 'zip', ALL_FIELDS)).body as Buffer);
    expect(masked).toEqual(verbatim);
  });

  it('снятая галочка поля — единственный способ что-то потерять, и он осознанный', async () => {
    const before = await loadProject('Rich');
    // Снимаем «Описание»: остальные поля обязаны уцелеть, описание — исчезнуть.
    const { requirements } = await roundTrip(
      await svc.export('Rich', 'zip', ['source', 'info', 'links']),
      'Copy without description',
    );
    expect(requirements.map((r) => r.description ?? '')).toEqual(['', '', '']);
    expect(requirements.map((r) => r.name)).toEqual(before.map((r) => r.name));
    expect(requirements.map((r) => r.links)).toEqual(before.map((r) => r.links));
    expect(requirements.map((r) => r.sources)).toEqual(before.map((r) => r.sources));
    expect(requirements.map((r) => r.infoItems)).toEqual(before.map((r) => r.infoItems));
  });

  it('посторонние файлы каталога проекта переживают экспорт из UI', async () => {
    // Пользователь может положить в каталог проекта свои файлы (заметку,
    // вложение, схему). Побайтовое копирование их переносит; путь с маской
    // полей собирает архив из известных сущностей — проверяем, что и он
    // ничего не теряет, когда маска не сужает состав.
    const projectDir = path.join(root, 'Rich');
    await fs.mkdir(path.join(projectDir, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'NOTES.md'), '# Заметки PO\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'attachments', 'scheme.txt'), 'схема', 'utf8');

    const listOf = (buf: Buffer): string[] =>
      new AdmZip(buf)
        .getEntries()
        .filter((e) => !e.isDirectory)
        .map((e) => e.entryName.split(path.sep).join('/'))
        .sort();

    const verbatim = listOf((await svc.export('Rich', 'zip')).body as Buffer);
    expect(verbatim).toContain('NOTES.md');
    expect(verbatim).toContain('attachments/scheme.txt');

    const masked = listOf((await svc.export('Rich', 'zip', ALL_FIELDS)).body as Buffer);
    expect(masked).toContain('NOTES.md');
    expect(masked).toContain('attachments/scheme.txt');
  });

  it('нечитаемый .md не исчезает из архива — данные PO уходят как есть', async () => {
    // Файл, который не парсится (правка руками, будущий формат): читать его
    // портал не умеет, но терять содержимое при экспорте нельзя.
    const broken = path.join(root, 'Rich', 'openspec', 'specs', 'functions', 'broken-by-hand.md');
    await fs.writeFile(broken, 'этот файл сломан, но это данные PO\n', 'utf8');

    const listOf = (buf: Buffer): Map<string, string> =>
      new Map(
        new AdmZip(buf)
          .getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => [e.entryName.split(path.sep).join('/'), e.getData().toString('utf8')]),
      );

    for (const exported of [
      await svc.export('Rich', 'zip'),
      await svc.export('Rich', 'zip', ALL_FIELDS),
    ]) {
      const files = listOf(exported.body as Buffer);
      const entry = files.get('openspec/specs/functions/broken-by-hand.md');
      expect(entry, 'сломанный .md пропал из архива').toBeDefined();
      expect(entry).toContain('это данные PO');
    }
  });
});
