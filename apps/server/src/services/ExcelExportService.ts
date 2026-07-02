import ExcelJS from 'exceljs';
import type { Criticality, LinkType, Requirement, RequirementType } from '@po/core';

/** Sheet name — mirrors the portal's requirements table. */
const SHEET_NAME = 'Требования';

/** Human-readable column headers (order = export layout, matches the UI table). */
const HEADERS = ['Требование', 'Тип', 'Критичность', 'Реализация', 'Описание', 'Связи'] as const;

/** UI label for a requirement type. */
const TYPE_LABEL: Record<RequirementType, string> = {
  FUNCTION: 'ФТ',
  NFR: 'НФТ',
};

/** UI label for a criticality level (mirrors apps/web criticality.ts). */
const CRITICALITY_LABEL: Record<Criticality, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
  BLOCKER: 'Blocker',
};

/** Soft background tint per criticality (ARGB) — cosmetic cue for the cell. */
const CRITICALITY_FILL: Record<Criticality, string> = {
  LOW: 'FFDCFCE7',
  MEDIUM: 'FFFEF9C3',
  HIGH: 'FFFFEDD5',
  CRITICAL: 'FFFEE2E2',
  BLOCKER: 'FFFECACA',
};

/** Readable phrase per link type (mirrors apps/web linkTypes.ts LINK_TYPE_LABEL). */
const LINK_TYPE_LABEL: Record<LinkType, string> = {
  CHILD_OF: 'является дочерней',
  PARENT_OF: 'является родителем',
  RELATES_TO: 'связана с',
  DEPENDS_ON: 'зависит от',
  BLOCKED_BY: 'блокируется',
};

/** A requirement paired with its hierarchy depth (0 = root). */
interface OrderedRow {
  req: Requirement;
  depth: number;
}

/** Parent slug of a requirement, derived from its CHILD_OF link (mirrors tree.ts). */
function parentSlugOf(req: Requirement): string | undefined {
  return req.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
}

/**
 * Order a set of requirements as a depth-first tree walk.
 *
 * Roots (no in-set CHILD_OF parent) come first, sorted by name; each node's
 * children (its PARENT_OF targets, resolved via the reciprocal CHILD_OF) follow
 * in depth. Cycle-safe: a shared `seen` set guarantees every requirement is
 * emitted at most once, and any node unreachable from a root (e.g. trapped in a
 * cycle) is appended at depth 0 so the row count always equals the input size.
 */
function orderTree(reqs: readonly Requirement[]): OrderedRow[] {
  const bySlug = new Map(reqs.map((r) => [r.slug, r]));
  const childrenOf = new Map<string, Requirement[]>();
  const roots: Requirement[] = [];

  for (const req of reqs) {
    const parent = parentSlugOf(req);
    if (parent && bySlug.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(req);
      childrenOf.set(parent, list);
    } else {
      roots.push(req);
    }
  }

  const byName = (a: Requirement, b: Requirement): number => a.name.localeCompare(b.name, 'ru');
  const out: OrderedRow[] = [];
  const seen = new Set<string>();

  const walk = (req: Requirement, depth: number): void => {
    if (seen.has(req.slug)) return;
    seen.add(req.slug);
    out.push({ req, depth });
    [...(childrenOf.get(req.slug) ?? [])].sort(byName).forEach((c) => walk(c, depth + 1));
  };

  [...roots].sort(byName).forEach((r) => walk(r, 0));
  // Defensive: emit any requirement not reached via a root (cycle guard).
  [...reqs].sort(byName).forEach((r) => walk(r, 0));

  return out;
}

/** Delivery status text: `Реализовано`, or the planned `Q<n> <year>` target. */
function formatImplementation(req: Requirement): string {
  if (req.implemented) return 'Реализовано';
  if (req.targetQuarter && req.targetYear) return `${req.targetQuarter} ${req.targetYear}`;
  return '';
}

/** Render a requirement's links as `<phrase> «<target name>»`, joined by `; `. */
function formatLinks(req: Requirement, nameBySlug: ReadonlyMap<string, string>): string {
  return req.links
    .map((l) => `${LINK_TYPE_LABEL[l.type]} «${nameBySlug.get(l.targetSlug) ?? l.targetSlug}»`)
    .join('; ');
}

/**
 * Builds a human-readable Excel (.xlsx) workbook that mirrors the portal's
 * requirements table (E15 · T5).
 *
 * A single `Требования` sheet: the FUNCTION section first (tree order), then the
 * NFR section (tree order). Columns: Требование (indented by hierarchy depth),
 * Тип (ФТ/НФТ), Критичность (Low…Blocker), Реализация (`Реализовано` or a
 * planned `Q<n> <year>`), Описание (plain markdown text), Связи (link phrases
 * with resolved target names). Link target names are resolved by slug within the
 * supplied set. Export-only: xlsx import is intentionally unsupported (A6#6).
 */
export class ExcelExportService {
  /** Build the workbook and serialise it to a `.xlsx` byte buffer. */
  static async buildWorkbook(reqs: readonly Requirement[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME);
    ws.columns = [
      { header: HEADERS[0], key: 'name', width: 44 },
      { header: HEADERS[1], key: 'type', width: 8 },
      { header: HEADERS[2], key: 'criticality', width: 14 },
      { header: HEADERS[3], key: 'implementation', width: 16 },
      { header: HEADERS[4], key: 'description', width: 50 },
      { header: HEADERS[5], key: 'links', width: 50 },
    ];
    ws.getRow(1).font = { bold: true };

    // slug → name across the whole set (both sections) for link resolution.
    const nameBySlug = new Map(reqs.map((r) => [r.slug, r.name]));

    const functions = reqs.filter((r) => r.type === 'FUNCTION');
    const nfrs = reqs.filter((r) => r.type === 'NFR');
    const ordered: OrderedRow[] = [...orderTree(functions), ...orderTree(nfrs)];

    for (const { req, depth } of ordered) {
      const row = ws.addRow({
        name: req.name,
        type: TYPE_LABEL[req.type],
        criticality: CRITICALITY_LABEL[req.criticality],
        implementation: formatImplementation(req),
        // Description is stored as plain markdown text; exported verbatim (no rendering).
        description: req.description ?? '',
        links: formatLinks(req, nameBySlug),
      });
      // Indent the requirement name by its hierarchy depth to show nesting.
      row.getCell('name').alignment = { indent: depth, vertical: 'top' };
      row.getCell('criticality').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: CRITICALITY_FILL[req.criticality] },
      };
    }

    const out = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  }
}
