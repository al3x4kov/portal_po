import { describe, expect, it } from 'vitest';
import { REQUIREMENT_FOLDER, REQUIREMENT_TYPES, folderForType } from '../src/index.js';

describe('BE-8 requirement type → folder', () => {
  it('maps every requirement type to a folder name', () => {
    for (const t of REQUIREMENT_TYPES) {
      expect(REQUIREMENT_FOLDER[t]).toBeTypeOf('string');
    }
    expect(REQUIREMENT_FOLDER.FUNCTION).toBe('functions');
    expect(REQUIREMENT_FOLDER.NFR).toBe('nfr');
  });

  it('folderForType resolves the same value', () => {
    expect(folderForType('FUNCTION')).toBe('functions');
    expect(folderForType('NFR')).toBe('nfr');
  });
});
