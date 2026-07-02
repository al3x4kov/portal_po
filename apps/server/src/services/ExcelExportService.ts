import ExcelJS from 'exceljs';
import {
  CRITICALITY_LABEL,
  LINK_TYPE_LABEL,
  orderTree,
  type Criticality,
  type Requirement,
  type RequirementType,
} from '@po/core';

/** Sheet name — mirrors the portal's requirements table. */
const SHEET_NAME = 'Требования';

/** Human-readable column headers (order = export layout, matches the UI table). */
const HEADERS = ['Требование', 'Тип', 'Критичность', 'Реализация', 'Описание', 'Связи'] as const;

/** UI label for a requirement type. */
const TYPE_LABEL: Record<RequirementType, string> = {
  FUNCTION: 'ФТ',
  NFR: 'НФТ',
};

/** Soft background tint per criticality (ARGB) — cosmetic cue for the cell. */
const CRITICALITY_FILL: Record<Criticality, string> = {
  LOW: 'FFDCFCE7',
  MEDIUM: 'FFFEF9C3',
  HIGH: 'FFFFEDD5',
  CRITICAL: 'FFFEE2E2',
  BLOCKER: 'FFFECACA',
};

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
    const ordered = [...orderTree(functions), ...orderTree(nfrs)];

    for (const { requirement: req, depth } of ordered) {
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
