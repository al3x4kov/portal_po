import { describe, expect, it } from 'vitest';
import { ValidationError, validateRequirement } from '../src/index.js';
import { makeReq } from './fixtures.js';

describe('T-203 conditional target fields', () => {
  it('rejects not-implemented requirement missing both targets', () => {
    const req = { ...makeReq({ implemented: false }) };
    delete (req as Record<string, unknown>).targetQuarter;
    delete (req as Record<string, unknown>).targetYear;
    expect(() => validateRequirement(req)).toThrow(ValidationError);
  });

  it('rejects not-implemented requirement missing only the year', () => {
    const req = makeReq({ implemented: false, targetQuarter: 'Q1' });
    delete (req as Record<string, unknown>).targetYear;
    expect(() => validateRequirement(req)).toThrow(ValidationError);
  });

  it('accepts not-implemented requirement with both targets', () => {
    const req = makeReq({ implemented: false, targetQuarter: 'Q4', targetYear: 2030 });
    const out = validateRequirement(req);
    expect(out.targetQuarter).toBe('Q4');
    expect(out.targetYear).toBe(2030);
  });

  it('clears target fields when implemented = true', () => {
    const req = makeReq({ implemented: true, targetQuarter: 'Q2', targetYear: 2026 });
    const out = validateRequirement(req);
    expect(out.targetQuarter).toBeUndefined();
    expect(out.targetYear).toBeUndefined();
  });
});

describe('T-203 length and range constraints', () => {
  it('rejects an empty name', () => {
    expect(() => validateRequirement(makeReq({ name: '' }))).toThrow(ValidationError);
  });

  it('rejects a name longer than 200 chars', () => {
    expect(() => validateRequirement(makeReq({ name: 'x'.repeat(201) }))).toThrow(ValidationError);
  });

  it('accepts a name of exactly 200 chars', () => {
    expect(validateRequirement(makeReq({ name: 'x'.repeat(200) })).name).toHaveLength(200);
  });

  it('rejects a description longer than 5000 chars', () => {
    expect(() => validateRequirement(makeReq({ description: 'x'.repeat(5001) }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a year below 2020', () => {
    expect(() =>
      validateRequirement(makeReq({ implemented: false, targetQuarter: 'Q1', targetYear: 2019 })),
    ).toThrow(ValidationError);
  });

  it('rejects a year above 2100', () => {
    expect(() =>
      validateRequirement(makeReq({ implemented: false, targetQuarter: 'Q1', targetYear: 2101 })),
    ).toThrow(ValidationError);
  });

  it('accepts boundary years 2020 and 2100', () => {
    expect(
      validateRequirement(makeReq({ implemented: false, targetQuarter: 'Q1', targetYear: 2020 }))
        .targetYear,
    ).toBe(2020);
    expect(
      validateRequirement(makeReq({ implemented: false, targetQuarter: 'Q1', targetYear: 2100 }))
        .targetYear,
    ).toBe(2100);
  });
});
