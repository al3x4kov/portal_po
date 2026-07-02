import { describe, expect, it } from 'vitest';
import {
  ParseError,
  SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  type ProjectManifest,
} from '../src/index.js';

describe('T-804 project manifest (openspec/project.md)', () => {
  const manifest: ProjectManifest = {
    name: 'My Project',
    schemaVersion: SCHEMA_VERSION,
    createdAt: '2026-06-29T10:00:00.000Z',
  };

  it('round-trips a manifest without loss', () => {
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('emits YAML frontmatter delimited by ---', () => {
    const md = serializeManifest(manifest);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: My Project');
  });

  it('preserves the ISO createdAt as a string (not a Date)', () => {
    const parsed = parseManifest(serializeManifest(manifest));
    expect(typeof parsed.createdAt).toBe('string');
    expect(parsed.createdAt).toBe('2026-06-29T10:00:00.000Z');
  });

  it('keeps names with reserved YAML characters intact', () => {
    const tricky: ProjectManifest = { ...manifest, name: 'a/b:c*?<>|"name' };
    expect(parseManifest(serializeManifest(tricky)).name).toBe('a/b:c*?<>|"name');
  });

  it('throws ParseError on malformed frontmatter', () => {
    expect(() => parseManifest('---\nname: : : broken\n  bad indent\n---\nbody')).toThrow(
      ParseError,
    );
  });

  it('throws ParseError when required fields are missing/invalid', () => {
    expect(() => parseManifest('---\nname: X\n---\n')).toThrow(ParseError);
    expect(() => parseManifest('no frontmatter at all')).toThrow(ParseError);
  });

  // ARCH-5 / SA-9: version boundary.
  it('accepts the current schemaVersion', () => {
    const md = serializeManifest({ ...manifest, schemaVersion: SCHEMA_VERSION });
    expect(parseManifest(md).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects an unknown future schemaVersion with a clear ParseError', () => {
    const future = serializeManifest({ ...manifest, schemaVersion: SCHEMA_VERSION + 1 });
    expect(() => parseManifest(future)).toThrow(ParseError);
    expect(() => parseManifest(future)).toThrow(/schemaVersion/i);
  });

  it('rejects a non-positive schemaVersion', () => {
    expect(() => parseManifest(serializeManifest({ ...manifest, schemaVersion: 0 }))).toThrow(
      ParseError,
    );
  });
});
