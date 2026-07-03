import { describe, expect, it } from 'vitest';
import {
  EXPORT_OPTIONAL_FIELDS,
  exportFieldsSchema,
  parseExportFields,
  serialize,
  type ExportOptionalField,
  type Requirement,
} from '../src/index.js';

function makeReq(overrides: Partial<Requirement> = {}): Requirement {
  return {
    slug: 'user-login',
    type: 'FUNCTION',
    name: 'User Login',
    criticality: 'HIGH',
    description: 'The system **SHALL** authenticate users.',
    implemented: false,
    targetQuarter: 'Q3',
    targetYear: 2026,
    source: 'АС21',
    scenarios: [{ name: 'Happy path', steps: [{ keyword: 'WHEN', text: 'user submits' }] }],
    links: [{ type: 'PARENT_OF', targetSlug: 'child' }],
    infoItems: [{ type: 'Регламент', value: 'РД-42' }],
    createdAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:00:00.000Z',
    ...overrides,
  };
}

describe('T-201 export field contract', () => {
  describe('EXPORT_OPTIONAL_FIELDS', () => {
    it('lists source, description, info, links in fixed order', () => {
      expect(EXPORT_OPTIONAL_FIELDS).toEqual(['source', 'description', 'info', 'links']);
    });
  });

  describe('parseExportFields', () => {
    it('undefined → all optional fields', () => {
      expect(parseExportFields(undefined)).toEqual(['source', 'description', 'info', 'links']);
    });
    it('empty string → empty array (minimum)', () => {
      expect(parseExportFields('')).toEqual([]);
    });
    it('comma list → array preserving input order', () => {
      expect(parseExportFields('links,source')).toEqual(['links', 'source']);
    });
    it('drops unknown tokens', () => {
      expect(parseExportFields('links,bogus,info')).toEqual(['links', 'info']);
    });
    it('dedupes repeated tokens', () => {
      expect(parseExportFields('source,source,links')).toEqual(['source', 'links']);
    });
    it('trims whitespace around tokens', () => {
      expect(parseExportFields(' links , source ')).toEqual(['links', 'source']);
    });
    it('whitespace-only string → empty array', () => {
      expect(parseExportFields('   ')).toEqual([]);
    });
  });

  describe('exportFieldsSchema', () => {
    it('accepts a valid subset', () => {
      expect(exportFieldsSchema.parse(['source', 'links'])).toEqual(['source', 'links']);
    });
    it('rejects an unknown value', () => {
      expect(exportFieldsSchema.safeParse(['bogus']).success).toBe(false);
    });
    it('accepts empty array', () => {
      expect(exportFieldsSchema.parse([])).toEqual([]);
    });
  });
});

describe('T-201 serialize with field mask', () => {
  it('without opts is byte-for-byte identical to the default serialize', () => {
    const req = makeReq();
    expect(serialize(req, {})).toBe(serialize(req));
    expect(serialize(req, { fields: undefined })).toBe(serialize(req));
  });

  it('fields:[] emits only mandatory sections', () => {
    const md = serialize(makeReq(), { fields: [] });
    expect(md).toContain('### Requirement: User Login');
    expect(md).toContain('- criticality: HIGH');
    expect(md).toContain('- implemented: false');
    expect(md).toContain('- target: Q3 2026');
    expect(md).toContain('- createdAt: 2026-06-29T10:00:00.000Z');
    expect(md).toContain('- updatedAt: 2026-06-29T10:00:00.000Z');
    expect(md).not.toContain('- source:');
    expect(md).not.toContain('authenticate users');
    expect(md).not.toContain('#### Scenario');
    expect(md).not.toContain('#### Links');
    expect(md).not.toContain('#### Info');
  });

  it("fields:['links'] emits only the Links section among optionals", () => {
    const md = serialize(makeReq(), { fields: ['links'] });
    expect(md).toContain('#### Links');
    expect(md).toContain('- PARENT_OF: child');
    expect(md).not.toContain('- source:');
    expect(md).not.toContain('authenticate users');
    expect(md).not.toContain('#### Scenario');
    expect(md).not.toContain('#### Info');
  });

  it("fields:['source'] emits only the source bullet among optionals", () => {
    const md = serialize(makeReq(), { fields: ['source'] });
    expect(md).toContain('- source: АС21');
    expect(md).not.toContain('authenticate users');
    expect(md).not.toContain('#### Scenario');
    expect(md).not.toContain('#### Links');
    expect(md).not.toContain('#### Info');
  });

  it("fields:['info'] emits only the Info section among optionals", () => {
    const md = serialize(makeReq(), { fields: ['info'] });
    expect(md).toContain('#### Info');
    expect(md).toContain('- Регламент: РД-42');
    expect(md).not.toContain('#### Links');
    expect(md).not.toContain('- source:');
  });

  it('description controls both the body and the #### Scenario blocks', () => {
    const md = serialize(makeReq(), { fields: ['description'] });
    expect(md).toContain('authenticate users');
    expect(md).toContain('#### Scenario: Happy path');
    expect(md).toContain('- WHEN user submits');

    const without = serialize(makeReq(), { fields: [] });
    expect(without).not.toContain('authenticate users');
    expect(without).not.toContain('#### Scenario');
  });

  it('does not emit an optional section when selected but the value is empty', () => {
    const bare = makeReq({
      source: undefined,
      description: undefined,
      scenarios: undefined,
      infoItems: undefined,
      links: [],
    });
    const md = serialize(bare, {
      fields: [...EXPORT_OPTIONAL_FIELDS] as ExportOptionalField[],
    });
    expect(md).not.toContain('- source:');
    expect(md).not.toContain('#### Scenario');
    expect(md).not.toContain('#### Links');
    expect(md).not.toContain('#### Info');
  });

  it('full field mask matches the default serialize (content lossless)', () => {
    const req = makeReq();
    expect(serialize(req, { fields: [...EXPORT_OPTIONAL_FIELDS] as ExportOptionalField[] })).toBe(
      serialize(req),
    );
  });
});
