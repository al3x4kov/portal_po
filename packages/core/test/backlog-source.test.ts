import { describe, expect, it } from 'vitest';
import { parse, serialize } from '../src/md/markdown.js';
import { requirementSchema, sourceEntrySchema } from '../src/validation/schema.js';
import type { Requirement } from '../src/domain/types.js';

/**
 * todo_22 · T-301: the new BACKLOG source type participates in the shared Zod
 * contract and survives the markdown round-trip; legacy documents (without
 * sources, or with the historical types) keep parsing unchanged.
 */
describe('BACKLOG source type', () => {
  const backlogSource = {
    type: 'BACKLOG' as const,
    name: 'Бэклог: Книга2.xlsx',
    priorityId: 'default',
    targetQuarter: 'Q1' as const,
    targetYear: 2027,
  };

  it('is accepted by the shared source entry schema', () => {
    expect(sourceEntrySchema.safeParse(backlogSource).success).toBe(true);
    expect(sourceEntrySchema.safeParse({ ...backlogSource, type: 'JIRA' }).success).toBe(false);
  });

  it('round-trips through markdown losslessly', () => {
    const req: Requirement = {
      slug: 'prosmotr-grafa-kommitov',
      type: 'FUNCTION',
      name: 'Просмотр графа коммитов',
      criticality: 'MEDIUM',
      description: 'Верстка графа коммитов\n\nКлюч бэклога: CRPV-155771',
      implemented: false,
      targetQuarter: 'Q1',
      targetYear: 2027,
      links: [],
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      sources: [backlogSource],
    };
    const md = serialize(req);
    expect(md).toContain('#### Sources');
    expect(md).toContain('"type":"BACKLOG"');
    const roundTripped = parse(md, { slug: req.slug, type: req.type });
    expect(roundTripped).toEqual(req);
  });

  it('keeps parsing legacy documents without a BACKLOG source', () => {
    const md = [
      '### Requirement: Экспорт отчёта',
      '- criticality: LOW',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00.000Z',
      '- updatedAt: 2026-01-01T00:00:00.000Z',
      '',
      '#### Sources',
      '- {"type":"TEXT","name":"АС21","priorityId":"default"}',
      '',
    ].join('\n');
    const req = parse(md, { slug: 'eksport-otcheta', type: 'FUNCTION' });
    expect(req.sources?.[0]?.type).toBe('TEXT');
    expect(requirementSchema.safeParse(req).success).toBe(true);
  });
});
