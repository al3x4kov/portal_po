import { describe, it, expect } from 'vitest';
import type { Requirement, SourceEntry } from '@po/core';
import { sourceNamesOf, hasNoSource, formatSourceCell } from './sources';

function src(name: string): SourceEntry {
  return { type: 'TEXT', name, priorityId: 'p1' };
}

function req(partial: Partial<Requirement>): Requirement {
  return {
    slug: 's',
    type: 'FUNCTION',
    name: 'R',
    criticality: 'MEDIUM',
    implemented: true,
    description: '',
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('sourceNamesOf (todo_19)', () => {
  it('reads names from sources[]', () => {
    expect(sourceNamesOf(req({ sources: [src('АС21'), src('ПАО')] }))).toEqual(['АС21', 'ПАО']);
  });

  it('trims names and drops empty ones', () => {
    expect(sourceNamesOf(req({ sources: [src('  АС21  '), src('   ')] }))).toEqual(['АС21']);
  });

  it('falls back to the legacy scalar source when sources[] is absent', () => {
    expect(sourceNamesOf(req({ source: 'Регламент' }))).toEqual(['Регламент']);
  });

  it('prefers sources[] over the legacy scalar when both are present', () => {
    expect(sourceNamesOf(req({ sources: [src('АС21')], source: 'legacy' }))).toEqual(['АС21']);
  });

  it('returns [] when there is no source at all', () => {
    expect(sourceNamesOf(req({}))).toEqual([]);
    expect(sourceNamesOf(req({ sources: [] }))).toEqual([]);
    expect(sourceNamesOf(req({ source: '   ' }))).toEqual([]);
  });
});

describe('hasNoSource', () => {
  it('is true only when the requirement carries no source', () => {
    expect(hasNoSource(req({}))).toBe(true);
    expect(hasNoSource(req({ sources: [] }))).toBe(true);
    expect(hasNoSource(req({ source: 'X' }))).toBe(false);
    expect(hasNoSource(req({ sources: [src('X')] }))).toBe(false);
  });
});

describe('formatSourceCell (export «Источник» column)', () => {
  it('joins multiple source names with «; »', () => {
    expect(formatSourceCell(req({ sources: [src('АС21'), src('ПАО')] }))).toBe('АС21; ПАО');
  });

  it('uses the legacy scalar when sources[] is missing', () => {
    expect(formatSourceCell(req({ source: 'Регламент' }))).toBe('Регламент');
  });

  it('is an empty string when there is no source', () => {
    expect(formatSourceCell(req({}))).toBe('');
  });
});
