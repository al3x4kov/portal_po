import { describe, expect, it } from 'vitest';
import { ParseError, parse, serialize } from '../src/index.js';
import type { Requirement } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('T-202 serialize/parse round-trip', () => {
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
      links: [
        link('CHILD_OF', '01J9YPARENT0000000000000000'),
        link('RELATES_TO', '01J9XREL00000000000000000000'),
      ],
    }),
    'NFR critical': makeReq({ type: 'NFR', criticality: 'CRITICAL', description: 'p99 < 200ms' }),
  };

  for (const [label, req] of Object.entries(cases)) {
    it(`round-trips: ${label}`, () => {
      const md = serialize(req);
      expect(parse(md)).toEqual(req);
    });
  }

  it('produces YAML frontmatter delimited by ---', () => {
    const md = serialize(makeReq());
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\n---');
  });

  it('preserves ISO timestamps as strings (not Date)', () => {
    const req = makeReq({ createdAt: '2026-06-29T10:00:00Z', updatedAt: '2026-06-29T11:00:00Z' });
    const parsed = parse(serialize(req));
    expect(typeof parsed.createdAt).toBe('string');
    expect(parsed.createdAt).toBe('2026-06-29T10:00:00Z');
  });

  it('treats an empty body as undefined description', () => {
    const req = makeReq({ description: undefined });
    const parsed = parse(serialize(req));
    expect(parsed.description).toBeUndefined();
  });
});

describe('T-202 ParseError handling', () => {
  it('throws ParseError (not a raw crash) on malformed YAML frontmatter', () => {
    const broken = '---\nname: : : broken\n  bad indent\n---\nbody';
    expect(() => parse(broken)).toThrow(ParseError);
  });

  it('throws ParseError on frontmatter that fails schema validation', () => {
    const invalid = '---\nid: x\ntype: BOGUS\nname: A\n---\n';
    expect(() => parse(invalid)).toThrow(ParseError);
  });

  it('throws ParseError when frontmatter is missing entirely', () => {
    expect(() => parse('just some text, no frontmatter')).toThrow(ParseError);
  });

  it('ParseError carries a human-readable message', () => {
    try {
      parse('---\nid: x\ntype: BOGUS\nname: A\n---\n');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message.length).toBeGreaterThan(0);
    }
  });
});
