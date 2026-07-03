import { describe, expect, it } from 'vitest';
import {
  ParseError,
  incompleteScenarios,
  parse,
  serialize,
  type ParseContext,
  type Requirement,
} from '../src/index.js';
import { link, makeReq } from './fixtures.js';

const ctxOf = (req: Requirement): ParseContext => ({ slug: req.slug, type: req.type });
const roundTrip = (req: Requirement): Requirement => parse(serialize(req), ctxOf(req));

describe('T-802 serialize/parse round-trip (S1)', () => {
  const cases: Record<string, Requirement> = {
    'implemented, no description': makeReq({ implemented: true }),
    'not implemented with targets': makeReq({
      implemented: false,
      targetQuarter: 'Q2',
      targetYear: 2027,
    }),
    'with markdown description': makeReq({
      description: '# Heading\n\nSome **bold** text with a list:\n\n- a\n- b',
    }),
    'with links': makeReq({
      links: [link('CHILD_OF', 'parent-requirement'), link('RELATES_TO', 'audit-log')],
    }),
    'NFR critical': makeReq({ type: 'NFR', criticality: 'CRITICAL', description: 'p99 < 200ms' }),
    'with scenarios': makeReq({
      description: 'Body text.',
      scenarios: [
        {
          name: 'Успешный вход',
          steps: [
            { keyword: 'GIVEN', text: 'сконфигурирован OIDC-провайдер' },
            { keyword: 'WHEN', text: 'пользователь выбирает «Войти через SSO»' },
            { keyword: 'THEN', text: 'создаётся сессия' },
            { keyword: 'AND', text: 'происходит редирект на дашборд' },
          ],
        },
      ],
    }),
    'scenarios + links together': makeReq({
      scenarios: [
        {
          name: 'S',
          steps: [
            { keyword: 'WHEN', text: 'x' },
            { keyword: 'THEN', text: 'y' },
          ],
        },
      ],
      links: [link('DEPENDS_ON', 'other-thing')],
    }),
  };

  for (const [label, req] of Object.entries(cases)) {
    it(`round-trips without loss: ${label}`, () => {
      expect(roundTrip(req)).toEqual(req);
    });
  }

  it('emits the OpenSpec header and does not emit slug/type inline', () => {
    const md = serialize(makeReq({ name: 'Авторизация по SSO', slug: 'avtorizaciya-po-sso' }));
    expect(md.startsWith('### Requirement: Авторизация по SSO\n')).toBe(true);
    expect(md).not.toContain('slug:');
    expect(md).not.toContain('type:');
  });

  it('emits metadata as bullets under the header', () => {
    const md = serialize(makeReq({ criticality: 'HIGH', implemented: true }));
    expect(md).toContain('- criticality: HIGH');
    expect(md).toContain('- implemented: true');
  });

  it('emits a target bullet only when not implemented', () => {
    expect(serialize(makeReq({ implemented: true }))).not.toContain('- target:');
    const md = serialize(makeReq({ implemented: false, targetQuarter: 'Q3', targetYear: 2026 }));
    expect(md).toContain('- target: Q3 2026');
  });

  it('preserves ISO timestamps as strings', () => {
    const req = makeReq({ createdAt: '2026-06-29T10:00:00Z', updatedAt: '2026-06-29T11:00:00Z' });
    const parsed = roundTrip(req);
    expect(parsed.createdAt).toBe('2026-06-29T10:00:00Z');
    expect(parsed.updatedAt).toBe('2026-06-29T11:00:00Z');
  });

  it('treats an empty body as undefined description', () => {
    const parsed = roundTrip(makeReq({ description: undefined }));
    expect(parsed.description).toBeUndefined();
  });
});

describe('T-802 ParseError handling (S2–S6)', () => {
  const base = [
    '### Requirement: Some Requirement',
    '- criticality: MEDIUM',
    '- implemented: true',
    '- createdAt: 2026-01-01T00:00:00Z',
    '- updatedAt: 2026-01-01T00:00:00Z',
  ];
  const ctx: ParseContext = { slug: 'some-requirement', type: 'FUNCTION' };

  it('S4: missing "### Requirement:" header → ParseError (not a crash)', () => {
    expect(() => parse('- criticality: HIGH\nbody', ctx)).toThrow(ParseError);
    expect(() => parse('just prose, no header', ctx)).toThrow(ParseError);
  });

  it('S2: implemented=false without target → ParseError', () => {
    const md = [
      '### Requirement: R',
      '- criticality: LOW',
      '- implemented: false',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
    ].join('\n');
    expect(() => parse(md, ctx)).toThrow(ParseError);
  });

  it('S3: implemented=true WITH target → ParseError', () => {
    const md = [
      '### Requirement: R',
      '- criticality: LOW',
      '- implemented: true',
      '- target: Q3 2026',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
    ].join('\n');
    expect(() => parse(md, ctx)).toThrow(ParseError);
  });

  it('S5: description longer than 5000 chars → ParseError', () => {
    const md = [...base, '', 'x'.repeat(5001)].join('\n');
    expect(() => parse(md, ctx)).toThrow(ParseError);
  });

  it('rejects an invalid criticality enum value', () => {
    const md = ['### Requirement: R', '- criticality: BOGUS', '- implemented: true'].join('\n');
    expect(() => parse(md, ctx)).toThrow(ParseError);
  });

  it('rejects a malformed target value', () => {
    const md = [
      '### Requirement: R',
      '- criticality: LOW',
      '- implemented: false',
      '- target: sometime',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
    ].join('\n');
    expect(() => parse(md, ctx)).toThrow(ParseError);
  });

  it('ParseError carries a human-readable message', () => {
    try {
      parse('no header', ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message.length).toBeGreaterThan(0);
    }
  });
});

describe('T-802 source and infoItems fields', () => {
  it('round-trips req with source and infoItems without loss', () => {
    const req = makeReq({
      source: 'АС21',
      infoItems: [
        { type: 'Регламент', value: 'ГОСТ 34' },
        { type: 'Приказ', value: '№123' },
      ],
    });
    expect(roundTrip(req)).toEqual(req);
  });

  it('backward compat: file without source or #### Info parses without error', () => {
    const req = makeReq();
    const parsed = roundTrip(req);
    expect(parsed.source).toBeUndefined();
    expect(parsed.infoItems).toBeUndefined();
  });

  it('tolerant parsing: line in #### Info without colon is skipped, no ParseError', () => {
    const md = [
      '### Requirement: R',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '',
      '#### Info',
      'this line has no colon',
      '- Регламент: ГОСТ 34',
    ].join('\n');
    const ctx: ParseContext = { slug: 'r', type: 'FUNCTION' };
    expect(() => parse(md, ctx)).not.toThrow();
    const parsed = parse(md, ctx);
    expect(parsed.infoItems).toEqual([{ type: 'Регламент', value: 'ГОСТ 34' }]);
  });

  it('source in meta: parse correctly reads - source: АС21', () => {
    const md = [
      '### Requirement: R',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '- source: АС21',
    ].join('\n');
    const ctx: ParseContext = { slug: 'r', type: 'FUNCTION' };
    const parsed = parse(md, ctx);
    expect(parsed.source).toBe('АС21');
  });

  it('infoItems round-trip: [{type:"Регламент", value:"ГОСТ 34"}] survives serialize→parse', () => {
    const req = makeReq({ infoItems: [{ type: 'Регламент', value: 'ГОСТ 34' }] });
    const parsed = roundTrip(req);
    expect(parsed.infoItems).toEqual([{ type: 'Регламент', value: 'ГОСТ 34' }]);
  });

  it('source with empty string is treated as undefined (not stored)', () => {
    const md = [
      '### Requirement: R',
      '- criticality: MEDIUM',
      '- implemented: true',
      '- createdAt: 2026-01-01T00:00:00Z',
      '- updatedAt: 2026-01-01T00:00:00Z',
      '- source:  ',
    ].join('\n');
    const ctx: ParseContext = { slug: 'r', type: 'FUNCTION' };
    const parsed = parse(md, ctx);
    expect(parsed.source).toBeUndefined();
  });

  it('serialize emits - source: when source is set', () => {
    const req = makeReq({ source: 'ПАО' });
    expect(serialize(req)).toContain('- source: ПАО');
  });

  it('serialize emits #### Info section when infoItems present', () => {
    const req = makeReq({ infoItems: [{ type: 'Тип', value: 'Знач' }] });
    const md = serialize(req);
    expect(md).toContain('#### Info');
    expect(md).toContain('- Тип: Знач');
  });

  it('serialize does NOT emit #### Info when infoItems is undefined or empty', () => {
    expect(serialize(makeReq())).not.toContain('#### Info');
    expect(serialize(makeReq({ infoItems: [] }))).not.toContain('#### Info');
  });
});

describe('T-802 scenarios are optional and completeness is flagged (S6)', () => {
  it('parses a requirement with no scenarios (scenarios undefined)', () => {
    const parsed = roundTrip(makeReq({ description: 'x' }));
    expect(parsed.scenarios).toBeUndefined();
  });

  it('S6: an incomplete scenario (no WHEN/THEN) is saved but flagged', () => {
    const req = makeReq({
      scenarios: [{ name: 'Half', steps: [{ keyword: 'GIVEN', text: 'a precondition' }] }],
    });
    const parsed = roundTrip(req);
    expect(parsed.scenarios).toHaveLength(1);
    expect(incompleteScenarios(parsed)).toEqual(['Half']);
  });

  it('a complete scenario is not flagged', () => {
    const req = makeReq({
      scenarios: [
        {
          name: 'Full',
          steps: [
            { keyword: 'WHEN', text: 'act' },
            { keyword: 'THEN', text: 'result' },
          ],
        },
      ],
    });
    expect(incompleteScenarios(roundTrip(req))).toEqual([]);
  });
});
