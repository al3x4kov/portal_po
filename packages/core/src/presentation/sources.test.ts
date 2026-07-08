import { describe, expect, it } from 'vitest';
import type { Requirement, SourceEntry } from '../domain/types.js';
import { formatSourceCell, sourceNamesOf } from './sources.js';

function req(overrides: Partial<Requirement> = {}): Requirement {
  return {
    slug: 'r',
    type: 'FUNCTION',
    name: 'R',
    criticality: 'HIGH',
    implemented: true,
    links: [],
    createdAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:00:00.000Z',
    ...overrides,
  };
}

function src(name: string): SourceEntry {
  return { type: 'STAKEHOLDER', name, priorityId: 'p1' };
}

describe('sourceNamesOf', () => {
  it('reads names from sources[] in order, trimmed, dropping empties', () => {
    expect(sourceNamesOf(req({ sources: [src('  A '), src('B'), src('   ')] }))).toEqual([
      'A',
      'B',
    ]);
  });

  it('falls back to the legacy scalar source when sources[] is absent', () => {
    expect(sourceNamesOf(req({ source: '  АС21 ' }))).toEqual(['АС21']);
  });

  it('prefers sources[] over the legacy scalar when both are present', () => {
    expect(sourceNamesOf(req({ source: 'legacy', sources: [src('new')] }))).toEqual(['new']);
  });

  it('returns [] when neither sources[] nor source are set', () => {
    expect(sourceNamesOf(req())).toEqual([]);
  });

  it('falls back to legacy scalar when sources[] is present but empty/whitespace-only', () => {
    expect(sourceNamesOf(req({ source: 'АС21', sources: [] }))).toEqual(['АС21']);
    expect(sourceNamesOf(req({ source: 'АС21', sources: [src('   ')] }))).toEqual(['АС21']);
  });
});

describe('formatSourceCell', () => {
  it('joins multiple source names with «; »', () => {
    expect(formatSourceCell(req({ sources: [src('имя1'), src('имя2')] }))).toBe('имя1; имя2');
  });

  it('renders the legacy scalar source verbatim', () => {
    expect(formatSourceCell(req({ source: 'АС21' }))).toBe('АС21');
  });

  it('is an empty string when there is no source', () => {
    expect(formatSourceCell(req())).toBe('');
  });
});
