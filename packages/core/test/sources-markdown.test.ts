import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  parse,
  serialize,
  validateRequirement,
  type ParseContext,
  type Requirement,
  type SourceEntry,
} from '../src/index.js';
import { makeReq } from './fixtures.js';

const ctxOf = (req: Requirement): ParseContext => ({ slug: req.slug, type: req.type });
const roundTrip = (req: Requirement): Requirement => parse(serialize(req), ctxOf(req));

describe('T-104 sources / releaseDate round-trip (lossless)', () => {
  it('round-trips a requirement with two fully-populated sources + releaseDate', () => {
    const sources: SourceEntry[] = [
      {
        type: 'CLIENT',
        name: 'Acme Corp',
        priorityId: 'p1',
        rice: { reach: 4, impact: 3, confidence: 0.8, effort: 3 },
        targetQuarter: 'Q2',
        targetYear: 2026,
        targetDate: '2026-05-01',
      },
      {
        type: 'STANDARD',
        name: 'ГОСТ 34',
        priorityId: 'p2',
        rice: { reach: 2, impact: 1, confidence: 1, effort: 1 },
        targetQuarter: 'Q3',
        targetYear: 2026,
      },
    ];
    const req = makeReq({
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
      releaseDate: '2026-11-05',
      sources,
    });
    expect(roundTrip(req)).toEqual(req);
  });

  it('does not emit sources / releaseDate sections when absent', () => {
    const md = serialize(makeReq());
    expect(md).not.toContain('#### Sources');
    expect(md).not.toContain('- releaseDate:');
  });

  it('a legacy file without sources parses (sources undefined)', () => {
    const parsed = roundTrip(makeReq({ description: 'x' }));
    expect(parsed.sources).toBeUndefined();
    expect(parsed.releaseDate).toBeUndefined();
  });
});

describe('T-105 legacy source → sources[0] TEXT migration', () => {
  const md = [
    '### Requirement: Legacy',
    '- criticality: MEDIUM',
    '- implemented: true',
    '- createdAt: 2026-01-01T00:00:00Z',
    '- updatedAt: 2026-01-01T00:00:00Z',
    '- source: АС21',
  ].join('\n');

  it('migrates legacy source into a single TEXT source with the default priorityId', () => {
    const req = parse(md, { slug: 'legacy', type: 'FUNCTION', defaultPriorityId: 'p-default' });
    expect(req.sources).toEqual([{ type: 'TEXT', name: 'АС21', priorityId: 'p-default' }]);
    expect(req.source).toBeUndefined();
  });

  it('leaves legacy source untouched when no default priority is supplied (pure round-trip)', () => {
    const req = parse(md, { slug: 'legacy', type: 'FUNCTION' });
    expect(req.source).toBe('АС21');
    expect(req.sources).toBeUndefined();
  });

  it('does not migrate when explicit sources already present', () => {
    const withSources = [
      md,
      '',
      '#### Sources',
      '- {"type":"CLIENT","name":"Acme","priorityId":"p1"}',
    ].join('\n');
    const req = parse(withSources, { slug: 'legacy', type: 'FUNCTION', defaultPriorityId: 'p-x' });
    expect(req.sources).toEqual([{ type: 'CLIENT', name: 'Acme', priorityId: 'p1' }]);
  });
});

describe('T-102 releaseDate rule', () => {
  it('clears releaseDate when implemented === true', () => {
    const req = makeReq({ implemented: true, releaseDate: '2026-05-01' });
    expect(validateRequirement(req).releaseDate).toBeUndefined();
  });

  it('keeps releaseDate when implemented === false', () => {
    const req = makeReq({
      implemented: false,
      targetQuarter: 'Q2',
      targetYear: 2026,
      releaseDate: '2026-05-01',
    });
    expect(validateRequirement(req).releaseDate).toBe('2026-05-01');
  });

  it('rejects a malformed releaseDate', () => {
    expect(() =>
      validateRequirement(
        makeReq({
          implemented: false,
          targetQuarter: 'Q2',
          targetYear: 2026,
          releaseDate: '2026-99-99',
        }),
      ),
    ).toThrow(ValidationError);
  });
});
