import { describe, expect, it } from 'vitest';
import {
  AI_ORIGINS,
  countAiPendingReview,
  isAiPendingReview,
  parse,
  requirementCreateShape,
  requirementUpdateShape,
  serialize,
  validateRequirement,
  ValidationError,
  type AiOrigin,
  type ParseContext,
  type Requirement,
} from '../src/index.js';
import { makeReq } from './fixtures.js';

/**
 * task26 — «создано ИИ, не проверено». Contract owner tests: the two optional
 * provenance fields (`origin`, `aiValidated`), the SINGLE source of the
 * highlight rule ({@link isAiPendingReview}) and lossless `.md` round-trip
 * including backwards compatibility with files written before task26.
 */

const ctxOf = (req: Requirement): ParseContext => ({ slug: req.slug, type: req.type });
const roundTrip = (req: Requirement): Requirement => parse(serialize(req), ctxOf(req));

describe('task26 · AI_ORIGINS + isAiPendingReview (single source of the rule)', () => {
  it('exposes exactly the two AI origins', () => {
    expect(AI_ORIGINS).toEqual(['AI_DOCS', 'AI_BACKLOG']);
  });

  const combos: Array<{ origin?: AiOrigin; aiValidated?: boolean; pending: boolean }> = [
    { origin: undefined, aiValidated: undefined, pending: false }, // human-made
    { origin: undefined, aiValidated: false, pending: false },
    { origin: undefined, aiValidated: true, pending: false },
    { origin: 'AI_DOCS', aiValidated: undefined, pending: true },
    { origin: 'AI_DOCS', aiValidated: false, pending: true },
    { origin: 'AI_DOCS', aiValidated: true, pending: false },
    { origin: 'AI_BACKLOG', aiValidated: undefined, pending: true },
    { origin: 'AI_BACKLOG', aiValidated: false, pending: true },
    { origin: 'AI_BACKLOG', aiValidated: true, pending: false },
  ];

  for (const { origin, aiValidated, pending } of combos) {
    it(`origin=${String(origin)} aiValidated=${String(aiValidated)} → pending=${String(pending)}`, () => {
      expect(isAiPendingReview({ origin, aiValidated })).toBe(pending);
      expect(isAiPendingReview(makeReq({ origin, aiValidated }))).toBe(pending);
    });
  }

  it('treats a missing requirement as not pending (defensive)', () => {
    expect(isAiPendingReview(undefined)).toBe(false);
    expect(isAiPendingReview(null)).toBe(false);
  });

  it('counts only the pending ones (tree counter «Не проверено: N»)', () => {
    expect(countAiPendingReview([])).toBe(0);
    expect(
      countAiPendingReview([
        makeReq(), // human
        makeReq({ origin: 'AI_DOCS' }), // pending
        makeReq({ origin: 'AI_BACKLOG', aiValidated: false }), // pending
        makeReq({ origin: 'AI_DOCS', aiValidated: true }), // reviewed
      ]),
    ).toBe(2);
  });
});

describe('task26 · schema', () => {
  it('accepts both fields', () => {
    const req = validateRequirement(makeReq({ origin: 'AI_DOCS', aiValidated: true }));
    expect(req.origin).toBe('AI_DOCS');
    expect(req.aiValidated).toBe(true);
  });

  it('keeps both fields optional (a pre-task26 requirement stays valid)', () => {
    const req = validateRequirement(makeReq());
    expect(req.origin).toBeUndefined();
    expect(req.aiValidated).toBeUndefined();
  });

  it('rejects an unknown origin', () => {
    expect(() => validateRequirement(makeReq({ origin: 'HUMAN' as AiOrigin }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a non-boolean aiValidated', () => {
    expect(() =>
      validateRequirement(makeReq({ aiValidated: 'yes' as unknown as boolean })),
    ).toThrow(ValidationError);
  });
});

describe('task26 · public input contracts', () => {
  it('does NOT accept origin or aiValidated on create (server-only provenance)', () => {
    expect(Object.keys(requirementCreateShape)).not.toContain('origin');
    expect(Object.keys(requirementCreateShape)).not.toContain('aiValidated');
  });

  it('accepts aiValidated (and only that) as the task26 field on update', () => {
    expect(Object.keys(requirementUpdateShape)).toContain('aiValidated');
    expect(Object.keys(requirementUpdateShape)).not.toContain('origin');
  });
});

describe('task26 · markdown round-trip (lossless)', () => {
  it('round-trips a requirement carrying origin + aiValidated=true', () => {
    const req = makeReq({ origin: 'AI_DOCS', aiValidated: true, description: 'Тело' });
    expect(roundTrip(req)).toEqual(req);
  });

  it('round-trips origin with an explicit aiValidated=false', () => {
    const req = makeReq({ origin: 'AI_BACKLOG', aiValidated: false });
    expect(roundTrip(req)).toEqual(req);
  });

  it('round-trips origin alone (never reviewed)', () => {
    const req = makeReq({ origin: 'AI_BACKLOG' });
    const back = roundTrip(req);
    expect(back).toEqual(req);
    expect(back.aiValidated).toBeUndefined();
    expect(isAiPendingReview(back)).toBe(true);
  });

  it('emits no origin/aiValidated bullets for a human-made requirement', () => {
    const human = makeReq({ description: 'Тело' });
    const md = serialize(human);
    expect(md).not.toContain('- origin:');
    expect(md).not.toContain('- aiValidated:');
    expect(roundTrip(human)).toEqual(human);
  });

  it('parses a legacy .md written before task26 as human-made', () => {
    const md = [
      '### Requirement: Legacy',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '',
      'Описание.',
    ].join('\n');
    const req = parse(md, { slug: 'legacy', type: 'FUNCTION' });
    expect(req.origin).toBeUndefined();
    expect(req.aiValidated).toBeUndefined();
    expect(isAiPendingReview(req)).toBe(false);
  });

  it('rejects a malformed aiValidated bullet', () => {
    const md = [
      '### Requirement: Broken',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '- aiValidated: maybe',
    ].join('\n');
    expect(() => parse(md, { slug: 'broken', type: 'FUNCTION' })).toThrow(/aiValidated/);
  });

  it('rejects an unknown origin bullet', () => {
    const md = [
      '### Requirement: Broken',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '- origin: HAND_MADE',
    ].join('\n');
    expect(() => parse(md, { slug: 'broken', type: 'FUNCTION' })).toThrow(/origin/);
  });
});
