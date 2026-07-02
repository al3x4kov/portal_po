import { describe, it, expect } from 'vitest';
import { buildLineGuides } from './treeLines';
import type { VisibleRow } from './visibility';
import type { Requirement } from '@po/core';

function makeReq(slug: string): Requirement {
  return {
    slug,
    type: 'FUNCTION',
    name: slug,
    criticality: 'HIGH',
    links: [],
    implemented: true,
    createdAt: '',
    updatedAt: '',
  };
}

function row(slug: string, depth: number, hasChildren = false): VisibleRow {
  return {
    requirement: makeReq(slug),
    depth,
    kind: 'match',
    hasChildren,
    hiddenCount: 0,
  };
}

describe('buildLineGuides', () => {
  it('single root node returns [[]]', () => {
    const rows: VisibleRow[] = [row('root', 0)];
    expect(buildLineGuides(rows)).toEqual([[]]);
  });

  it('two root nodes return [[], []]', () => {
    const rows: VisibleRow[] = [row('a', 0), row('b', 0)];
    expect(buildLineGuides(rows)).toEqual([[], []]);
  });

  it('parent with single child → [[], ["elbow"]]', () => {
    const rows: VisibleRow[] = [row('parent', 0, true), row('child', 1)];
    expect(buildLineGuides(rows)).toEqual([[], ['elbow']]);
  });

  it('parent with two children → [[], ["tee"], ["elbow"]]', () => {
    const rows: VisibleRow[] = [
      row('parent', 0, true),
      row('child1', 1, false),
      row('child2', 1, false),
    ];
    expect(buildLineGuides(rows)).toEqual([[], ['tee'], ['elbow']]);
  });

  it('3-level tree: root→child1→grandchild, child2 → correct guides', () => {
    // Structure:
    //  root (0)
    //  ├─ child1 (1)
    //  │  └─ grandchild (2)
    //  └─ child2 (1)
    const rows: VisibleRow[] = [
      row('root', 0, true),
      row('child1', 1, true),
      row('grandchild', 2, false),
      row('child2', 1, false),
    ];
    expect(buildLineGuides(rows)).toEqual([
      [],
      ['tee'],
      ['vert', 'elbow'],
      ['elbow'],
    ]);
  });
});
