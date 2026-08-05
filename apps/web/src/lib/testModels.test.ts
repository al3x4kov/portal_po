import { describe, it, expect } from 'vitest';
import type { Requirement } from '@po/core';
import {
  generateTracker,
  generateSmoke,
  generateCritRegression,
  generateFull,
  buildAiDoc,
  buildSmokeDoc,
  buildTemplateDoc,
  buildTrackerDoc,
  selectForKind,
} from './testModels';
import { makeReq } from '../test/fixtures';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeNameMap(reqs: Requirement[]): Map<string, string> {
  return new Map(reqs.map((r) => [r.slug, r.name]));
}

const ftA = makeReq({
  slug: 'ft-a',
  name: 'ФТ А',
  criticality: 'BLOCKER',
  description: 'Описание А',
  implemented: true,
  links: [
    { type: 'PARENT_OF', targetSlug: 'ft-b' },
    { type: 'PARENT_OF', targetSlug: 'ft-c' },
    { type: 'RELATES_TO', targetSlug: 'ft-outside' }, // not in export set
  ],
});

const ftB = makeReq({
  slug: 'ft-b',
  name: 'ФТ Б',
  criticality: 'HIGH',
  description: 'Описание Б',
  implemented: true,
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-a' }],
});

const ftC = makeReq({
  slug: 'ft-c',
  name: 'ФТ В',
  criticality: 'MEDIUM',
  description: 'Описание В',
  implemented: false,
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-a' }],
});

const nfrA = makeReq({
  slug: 'nfr-a',
  name: 'НФТ А',
  type: 'NFR',
  criticality: 'HIGH',
  description: 'НФТ описание',
  implemented: true,
  links: [],
});

/** FT that has a BLOCKED_BY link to an NFR */
const ftWithNfrLink = makeReq({
  slug: 'ft-with-nfr',
  name: 'ФТ с НФТ',
  criticality: 'CRITICAL',
  description: 'Есть описание',
  implemented: true,
  links: [{ type: 'BLOCKED_BY', targetSlug: 'nfr-a' }],
});

// ─── T-528: generateTracker link filtering ────────────────────────────────────

describe('T-528 — generateTracker link filtering', () => {
  it('includes links whose targetSlug is in the export set', () => {
    const reqs = [ftA, ftB, ftC];
    const exportSet = new Set(['ft-a', 'ft-b', 'ft-c']);
    const md = generateTracker(reqs, exportSet);

    // ft-a has PARENT_OF ft-b and ft-c — both in export set
    expect(md).toContain('PARENT_OF: ft-b');
    expect(md).toContain('PARENT_OF: ft-c');
  });

  it('excludes links whose targetSlug is NOT in the export set', () => {
    const reqs = [ftA, ftB]; // ftC excluded from export
    const exportSet = new Set(['ft-a', 'ft-b']);
    const md = generateTracker(reqs, exportSet);

    // ft-a has PARENT_OF ft-c but ft-c is not in export set
    expect(md).not.toContain('PARENT_OF: ft-c');
    // ft-a has RELATES_TO ft-outside — also not in export
    expect(md).not.toContain('RELATES_TO: ft-outside');
    // but PARENT_OF ft-b should still be there
    expect(md).toContain('PARENT_OF: ft-b');
  });

  it('tracker MD excludes links to requirements not in export set', () => {
    // ft-a has 3 links: PARENT_OF ft-b, PARENT_OF ft-c, RELATES_TO ft-outside
    // Export set includes only ft-a and ft-b (2 of 3)
    const reqs = [ftA, ftB];
    const exportSet = new Set(['ft-a', 'ft-b']);
    const md = generateTracker(reqs, exportSet);

    // Only ft-b link should appear
    const ftASection = md.slice(md.indexOf('## ФТ А'));
    expect(ftASection).toContain('PARENT_OF: ft-b');
    expect(ftASection).not.toContain('ft-c');
    expect(ftASection).not.toContain('ft-outside');
  });

  it('NFR inclusion: tracker MD includes NFR links when NFR is in includedSlugs', () => {
    const reqs = [ftWithNfrLink, nfrA];
    const exportSet = new Set(['ft-with-nfr', 'nfr-a']);
    const md = generateTracker(reqs, exportSet);

    // BLOCKED_BY nfr-a should appear since nfr-a is in export
    expect(md).toContain('BLOCKED_BY: nfr-a');
  });

  it('NFR exclusion: tracker MD excludes NFR links when NFR not in includedSlugs', () => {
    const reqs = [ftWithNfrLink]; // nfr-a not in export
    const exportSet = new Set(['ft-with-nfr']);
    const md = generateTracker(reqs, exportSet);

    // BLOCKED_BY nfr-a should NOT appear since nfr-a is not in export set
    expect(md).not.toContain('BLOCKED_BY: nfr-a');
  });

  it('when no includedSlugs provided, uses all reqs slugs as default', () => {
    const reqs = [ftA, ftB, ftC];
    const md = generateTracker(reqs);

    // All links among reqs should be present
    // ft-a has PARENT_OF ft-b and ft-c (both in reqs)
    expect(md).toContain('PARENT_OF: ft-b');
    expect(md).toContain('PARENT_OF: ft-c');
    // RELATES_TO ft-outside is NOT in reqs → excluded
    expect(md).not.toContain('RELATES_TO: ft-outside');
  });
});

// ─── T-532: attribution line removal ─────────────────────────────────────────

describe('T-532 — generator attribution', () => {
  const allReqs = [ftA, ftB, ftC];
  const nameMap = makeNameMap(allReqs);

  it('generateSmoke header line starts with # Smoke-модель', () => {
    const md = generateSmoke(allReqs, nameMap);
    expect(md).toContain('# Smoke-модель тестирования');
  });

  it('generateCritRegression header contains # Критический', () => {
    const md = generateCritRegression(allReqs, nameMap);
    expect(md).toContain('# Критический регресс-модель');
  });

  it('generateFull header contains # Полная модель', () => {
    const md = generateFull(allReqs, nameMap);
    expect(md).toContain('# Полная модель тестирования');
  });
});

describe('Task 12 — generator ordering branches', () => {
  it('generateSmoke orders equal criticality: roots before children, unimplemented before implemented', () => {
    const rootDone = makeReq({ slug: 'root-done', name: 'Корень готов', criticality: 'HIGH' });
    const rootPlanned = makeReq({
      slug: 'root-planned',
      name: 'Корень в плане',
      criticality: 'HIGH',
      implemented: false,
    });
    const childHigh = makeReq({
      slug: 'child-high',
      name: 'Дочка',
      criticality: 'HIGH',
      links: [{ type: 'CHILD_OF', targetSlug: 'root-done' }],
    });
    const md = generateSmoke([childHigh, rootDone, rootPlanned], new Map());

    const posPlanned = md.indexOf('req-slug: root-planned');
    const posDone = md.indexOf('req-slug: root-done');
    const posChild = md.indexOf('req-slug: child-high');
    // Same criticality: roots first; among roots — unimplemented first.
    expect(posPlanned).toBeLessThan(posDone);
    expect(posDone).toBeLessThan(posChild);
  });

  it('generateCritRegression orders equal criticality by child count, then unimplemented first', () => {
    const wide = makeReq({
      slug: 'wide',
      name: 'Широкий узел',
      criticality: 'CRITICAL',
      links: [
        { type: 'PARENT_OF', targetSlug: 'a' },
        { type: 'PARENT_OF', targetSlug: 'b' },
        { type: 'PARENT_OF', targetSlug: 'c' },
      ],
    });
    const narrowPlanned = makeReq({
      slug: 'narrow-planned',
      name: 'Узкий в плане',
      criticality: 'CRITICAL',
      implemented: false,
    });
    const narrowDone = makeReq({
      slug: 'narrow-done',
      name: 'Узкий готов',
      criticality: 'CRITICAL',
    });
    const md = generateCritRegression([narrowDone, narrowPlanned, wide], new Map());

    const posWide = md.indexOf('req-slug: wide');
    const posPlanned = md.indexOf('req-slug: narrow-planned');
    const posDone = md.indexOf('req-slug: narrow-done');
    expect(posWide).toBeLessThan(posPlanned);
    expect(posPlanned).toBeLessThan(posDone);
    // Wide node lists its children in covers-children.
    expect(md).toContain('covers-children:');
  });

  it('generateTracker emits targetQuarter/targetYear for planned requirements', () => {
    const planned = makeReq({
      slug: 'planned-q',
      name: 'Плановое',
      implemented: false,
      targetQuarter: 'Q4',
      targetYear: 2026,
    });
    const md = generateTracker([planned]);
    expect(md).toContain('targetQuarter: Q4');
    expect(md).toContain('targetYear: 2026');
  });

  it('generateFull links a child test case to its parent via parent-tc and lists RELATES_TO slugs', () => {
    const parent = makeReq({
      slug: 'p1',
      name: 'Платежи',
      links: [{ type: 'PARENT_OF', targetSlug: 'c1' }],
    });
    const child = makeReq({
      slug: 'c1',
      name: 'Оплата картой',
      links: [
        { type: 'CHILD_OF', targetSlug: 'p1' },
        { type: 'RELATES_TO', targetSlug: 'p1' },
      ],
    });
    const md = generateFull([parent, child], new Map());
    expect(md).toContain('parent-tc: FUL-001');
    expect(md).toContain('**Связанные требования:** p1');
  });
});

// ─── Блочная сборка: карточный предпросмотр экрана «Результат» ───────────────

describe('testModels — блоки документа', () => {
  const reqs = [ftA, ftB, ftC, nfrA];

  it('doc.md — это шапка плюс блоки, а блок заканчивается своим телом', () => {
    const doc = buildSmokeDoc(reqs);
    expect(doc.md).toBe([doc.header, ...doc.blocks.map((b) => b.md)].join('\n'));
    expect(doc.blocks.every((b) => b.md.endsWith(b.body))).toBe(true);
    expect(doc.blocks.every((b) => !b.body.includes('req-slug:'))).toBe(true);
  });

  it('шаблонные блоки нумеруются подряд и помечены источником «template»', () => {
    const doc = buildSmokeDoc(reqs);
    expect(doc.blocks.map((b) => b.tcId)).toEqual(
      doc.blocks.map((_, i) => `SMK-${String(i + 1).padStart(3, '0')}`),
    );
    expect(new Set(doc.blocks.map((b) => b.source))).toEqual(new Set(['template']));
  });

  it('buildTemplateDoc выбирает генератор по виду модели', () => {
    expect(buildTemplateDoc('smoke', reqs).md).toBe(generateSmoke(reqs));
    expect(buildTemplateDoc('crit-regression', reqs).md).toBe(generateCritRegression(reqs));
    expect(buildTemplateDoc('full', reqs).md).toBe(generateFull(reqs));
  });

  it('buildTrackerDoc даёт по блоку на требование', () => {
    const doc = buildTrackerDoc([ftA, ftB], new Set(['ft-a', 'ft-b']));
    expect(doc.blocks.map((b) => b.slug)).toEqual(['ft-a', 'ft-b']);
    expect(doc.md).toBe(generateTracker([ftA, ftB], new Set(['ft-a', 'ft-b'])));
  });

  it('AI-сборка помечает кейсы модели «ai», а пропущенные — «template» и source: template-fallback', () => {
    const ordered = selectForKind('smoke', reqs);
    const covered = ordered[0]!;
    const doc = buildAiDoc(
      'smoke',
      ordered,
      new Map([
        [
          covered.slug,
          {
            slug: covered.slug,
            title: 'Проверка от модели',
            goal: 'цель',
            precondition: 'предусловие',
            steps: ['шаг'],
            expected: 'ожидаемо',
          },
        ],
      ]),
      { model: 'm-1', aiCases: 1, fallbackCases: ordered.length - 1, dropped: 3 },
    );
    const first = doc.blocks[0]!;
    expect(first.source).toBe('ai');
    expect(first.title).toBe('Проверка от модели');
    expect(first.md).toContain('source: ai');
    expect(first.md).toContain(`**Требование:** ${covered.name}`);
    for (const b of doc.blocks.slice(1)) {
      expect(b.source).toBe('template');
      expect(b.md).toContain('source: template-fallback');
    }
    // Шапка честно фиксирует счётчики анти-галлюцинационной проверки.
    expect(doc.header).toContain('Кейсов от модели: 1');
    expect(doc.header).toContain('отброшено ответов с несуществующей привязкой: 3');
  });

  it('охват модели не зависит от способа генерации: один и тот же отбор', () => {
    const ordered = selectForKind('smoke', reqs);
    expect(buildSmokeDoc(reqs).blocks.map((b) => b.slug)).toEqual(ordered.map((r) => r.slug));
    expect(
      buildAiDoc('smoke', ordered, new Map(), {
        model: 'm',
        aiCases: 0,
        fallbackCases: ordered.length,
        dropped: 0,
      }).blocks.map((b) => b.slug),
    ).toEqual(ordered.map((r) => r.slug));
  });
});
