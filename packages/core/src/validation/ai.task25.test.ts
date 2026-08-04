import { describe, expect, it } from 'vitest';
import { aiBacklogApplyBodySchema, aiBacklogOverrideSchema } from './ai.js';

/**
 * task25 · review-step edits: the apply body gains an OPTIONAL `overrides`
 * record (rowId → per-row edit). Old clients that send `{rowIds}` only must
 * stay valid — backward compatibility is part of the contract.
 */
describe('task25 · aiBacklogApplyBodySchema overrides', () => {
  it('старое тело без overrides остаётся валидным (обратная совместимость)', () => {
    const parsed = aiBacklogApplyBodySchema.safeParse({ rowIds: ['r2', 'r3'] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.overrides).toBeUndefined();
  });

  it('принимает полный набор правок: имя, родитель, пара срока', () => {
    const parsed = aiBacklogApplyBodySchema.safeParse({
      rowIds: ['r2'],
      overrides: {
        r2: {
          businessName: '  Отчёт по продажам v2  ',
          parent: { kind: 'existing', name: 'Печать отчётов' },
          targetQuarter: 'Q4',
          targetYear: 2028,
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const ov = parsed.data.overrides!['r2']!;
      expect(ov.businessName).toBe('Отчёт по продажам v2'); // trimmed
      expect(ov.parent).toEqual({ kind: 'existing', name: 'Печать отчётов' });
      expect(ov.targetQuarter).toBe('Q4');
      expect(ov.targetYear).toBe(2028);
    }
  });

  it('пустой объект правки — допустимый no-op', () => {
    expect(aiBacklogOverrideSchema.safeParse({}).success).toBe(true);
  });

  it('пустое (после trim) бизнес-имя отклоняется', () => {
    const parsed = aiBacklogOverrideSchema.safeParse({ businessName: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('бизнес-имя длиннее 200 символов отклоняется', () => {
    const parsed = aiBacklogOverrideSchema.safeParse({ businessName: 'а'.repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it('квартал и год задаются только парой', () => {
    expect(aiBacklogOverrideSchema.safeParse({ targetQuarter: 'Q1' }).success).toBe(false);
    expect(aiBacklogOverrideSchema.safeParse({ targetYear: 2027 }).success).toBe(false);
    expect(
      aiBacklogOverrideSchema.safeParse({ targetQuarter: 'Q1', targetYear: 2027 }).success,
    ).toBe(true);
  });

  it('год вне диапазона 2020–2100 отклоняется', () => {
    expect(
      aiBacklogOverrideSchema.safeParse({ targetQuarter: 'Q1', targetYear: 2019 }).success,
    ).toBe(false);
    expect(
      aiBacklogOverrideSchema.safeParse({ targetQuarter: 'Q1', targetYear: 2101 }).success,
    ).toBe(false);
  });

  it('родитель: existing | new (корневой); неизвестный kind отклоняется', () => {
    expect(
      aiBacklogOverrideSchema.safeParse({ parent: { kind: 'new', name: 'Новый узел' } }).success,
    ).toBe(true);
    expect(aiBacklogOverrideSchema.safeParse({ parent: { kind: 'nope', name: 'x' } }).success).toBe(
      false,
    );
    expect(aiBacklogOverrideSchema.safeParse({ parent: { kind: 'new', name: '' } }).success).toBe(
      false,
    );
  });
});
