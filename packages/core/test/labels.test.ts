import { describe, expect, it } from 'vitest';
import { CRITICALITIES, CRITICALITY_LABEL, LINK_TYPES, LINK_TYPE_LABEL } from '../src/index.js';

describe('BE-3 presentation labels', () => {
  it('has a criticality label for every enum value', () => {
    for (const c of CRITICALITIES) {
      expect(CRITICALITY_LABEL[c]).toBeTypeOf('string');
      expect(CRITICALITY_LABEL[c].length).toBeGreaterThan(0);
    }
    expect(CRITICALITY_LABEL.BLOCKER).toBe('Blocker');
    expect(CRITICALITY_LABEL.LOW).toBe('Low');
  });

  it('has a link-type label for every enum value', () => {
    for (const t of LINK_TYPES) {
      expect(LINK_TYPE_LABEL[t]).toBeTypeOf('string');
      expect(LINK_TYPE_LABEL[t].length).toBeGreaterThan(0);
    }
    expect(LINK_TYPE_LABEL.CHILD_OF).toBe('является дочерней');
    expect(LINK_TYPE_LABEL.PARENT_OF).toBe('является родителем');
  });
});
