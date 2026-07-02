import type { VisibleRow } from './visibility';

export type LineGuide = 'vert' | 'tee' | 'elbow' | 'space';

/**
 * For each row in the visible list, returns an array of `LineGuide` values —
 * one entry per ancestor level (0..depth-1). Depth-0 rows always get `[]`.
 *
 * Guide semantics (rendered left-to-right):
 *  'vert'  — ancestor at this level still has siblings below → draw a vertical line
 *  'tee'   — this node's direct connector and more siblings follow → draw ├
 *  'elbow' — this node's direct connector and it is the last sibling → draw └
 *  'space' — ancestor at this level has ended → draw empty gap
 */
export function buildLineGuides(rows: VisibleRow[]): LineGuide[][] {
  return rows.map((row, i) => {
    const d = row.depth;
    if (d === 0) return [];

    const guides: LineGuide[] = [];

    for (let k = 0; k < d; k++) {
      if (k < d - 1) {
        // Ancestor connector: does level-k still have rows below us?
        // It does NOT if some row after i has depth <= k (meaning level-k
        // ancestor ended before index i+1 forward).
        const ancestorClosed = rows.slice(i + 1).some((r) => r.depth <= k);
        guides.push(ancestorClosed ? 'space' : 'vert');
      } else {
        // Direct parent connector (last guide cell).
        // 'elbow' when this is the last child, i.e. no subsequent row has depth >= d
        // before a row with depth < d-1 (same parent context).
        const isLastChild = !rows.slice(i + 1).some((r) => r.depth >= d);
        guides.push(isLastChild ? 'elbow' : 'tee');
      }
    }

    return guides;
  });
}
