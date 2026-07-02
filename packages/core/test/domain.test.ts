import { describe, expect, it } from 'vitest';
import {
  CRITICALITIES,
  LINK_TYPES,
  REQUIREMENT_TYPES,
  isValidId,
  linkSchema,
  newId,
  requirementSchema,
} from '../src/index.js';
import { makeReq } from './fixtures.js';

describe('T-201 newId / ULID', () => {
  it('generates syntactically valid ULIDs', () => {
    const id = newId();
    expect(isValidId(id)).toBe(true);
    expect(id).toHaveLength(26);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});

describe('T-201 enums', () => {
  it('exposes the spec enum members', () => {
    expect(REQUIREMENT_TYPES).toEqual(['FUNCTION', 'NFR']);
    expect(CRITICALITIES).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BLOCKER']);
    expect(LINK_TYPES).toEqual(['PARENT_OF', 'CHILD_OF', 'RELATES_TO', 'DEPENDS_ON', 'BLOCKED_BY']);
  });
});

describe('T-201 requirementSchema', () => {
  it('accepts a valid requirement', () => {
    const req = makeReq();
    expect(requirementSchema.safeParse(req).success).toBe(true);
  });

  it('accepts a not-implemented requirement with target fields', () => {
    const req = makeReq({ implemented: false, targetQuarter: 'Q3', targetYear: 2026 });
    expect(requirementSchema.safeParse(req).success).toBe(true);
  });

  it('rejects an unknown requirement type', () => {
    const req = { ...makeReq(), type: 'BUSINESS' };
    expect(requirementSchema.safeParse(req).success).toBe(false);
  });

  it('rejects an unknown criticality', () => {
    const req = { ...makeReq(), criticality: 'URGENT' };
    expect(requirementSchema.safeParse(req).success).toBe(false);
  });

  it('rejects a missing required field (slug)', () => {
    const { slug: _slug, ...rest } = makeReq();
    expect(requirementSchema.safeParse(rest).success).toBe(false);
  });

  it('defaults links to an empty array', () => {
    const { links: _links, ...rest } = makeReq();
    const parsed = requirementSchema.safeParse(rest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.links).toEqual([]);
  });
});

describe('T-201 linkSchema', () => {
  it('accepts a valid link', () => {
    expect(linkSchema.safeParse({ type: 'CHILD_OF', targetSlug: 'parent-req' }).success).toBe(true);
  });

  it('rejects an unknown link type', () => {
    expect(linkSchema.safeParse({ type: 'OWNS', targetSlug: 'parent-req' }).success).toBe(false);
  });

  it('rejects an empty targetSlug', () => {
    expect(linkSchema.safeParse({ type: 'CHILD_OF', targetSlug: '' }).success).toBe(false);
  });
});
