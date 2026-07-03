import ExcelJS from 'exceljs';
import {
  CRITICALITY_LABEL,
  LINK_TYPE_LABEL,
  orderTree,
  type Criticality,
  type ExportOptionalField,
  type Requirement,
  type RequirementType,
} from '@po/core';

/**
 * MIME type for an OOXML (.xlsx) workbook. Shared by the archive routes and the
 * project service so the Excel content-type is defined in exactly one place.
 */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sheet name — mirrors the portal's requirements table. */
const SHEET_NAME = 'Требования';

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

/** A dynamically-included optional column. */
interface OptionalColumn {
  field: ExportOptionalField;
  header: string;
  key: string;
  width: number;
  /** Whether the cell should wrap multi-line text (top-aligned). */
  wrap?: boolean;
  render: (req: Requirement, nameBySlug: ReadonlyMap<string, string>) => string;
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

/** Render reference info items as `<type>: <value>`, one per line inside the cell. */
function formatInfo(req: Requirement): string {
  return (req.infoItems ?? []).map((item) => `${item.type}: ${item.value}`).join('\n');
}

/**
 * Optional columns in their fixed left-to-right order (spec §2):
 * Источник → Описание → Справочная информация → Связи.
 */
const OPTIONAL_COLUMNS: readonly OptionalColumn[] = [
  {
    field: 'source',
    header: 'Источник',
    key: 'source',
    width: 18,
    render: (req) => req.source ?? '',
  },
  {
    field: 'description',
    header: 'Описание',
    key: 'description',
    width: 50,
    wrap: true,
    // Description is stored as plain markdown text; exported verbatim (no rendering).
    render: (req) => req.description ?? '',
  },
  {
    field: 'info',
    header: 'Справочная информация',
    key: 'info',
    width: 40,
    wrap: true,
    render: (req) => formatInfo(req),
  },
  {
    field: 'links',
    header: 'Связи',
    key: 'links',
    width: 50,
    wrap: true,
    render: (req, nameBySlug) => formatLinks(req, nameBySlug),
  },
];

/**
 * Builds a human-readable Excel (.xlsx) workbook that mirrors the portal's
 * requirements table (E15 · T5).
 *
 * A single `Требования` sheet: the FUNCTION section first (tree order), then the
 * NFR section (tree order). Base columns — Требование (indented by hierarchy
 * depth), Тип (ФТ/НФТ), Критичность (Low…Blocker, colour-filled), Реализация
 * (`Реализовано` or a planned `Q<n> <year>`) — are always present. Optional
 * columns (Источник, Описание, Справочная информация, Связи) follow in that
 * fixed order and are included per the `fields` selection (Task 2). `fields`
 * omitted/`undefined` includes them all (8 columns). Export-only: xlsx import is
 * intentionally unsupported (A6#6).
 */
export class ExcelExportService {
  /** Build the workbook and serialise it to a `.xlsx` byte buffer. */
  static async buildWorkbook(
    reqs: readonly Requirement[],
    fields?: ExportOptionalField[],
  ): Promise<Buffer> {
    const has = (field: ExportOptionalField): boolean =>
      fields === undefined || fields.includes(field);
    const optionalCols = OPTIONAL_COLUMNS.filter((c) => has(c.field));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME);
    ws.columns = [
      { header: 'Требование', key: 'name', width: 44 },
      { header: 'Тип', key: 'type', width: 8 },
      { header: 'Критичность', key: 'criticality', width: 14 },
      { header: 'Реализация', key: 'implementation', width: 16 },
      ...optionalCols.map((c) => ({ header: c.header, key: c.key, width: c.width })),
    ];
    ws.getRow(1).font = { bold: true };

    // slug → name across the whole set (both sections) for link resolution.
    const nameBySlug = new Map(reqs.map((r) => [r.slug, r.name]));

    const functions = reqs.filter((r) => r.type === 'FUNCTION');
    const nfrs = reqs.filter((r) => r.type === 'NFR');
    const ordered = [...orderTree(functions), ...orderTree(nfrs)];

    for (const { requirement: req, depth } of ordered) {
      const values: Record<string, string> = {
        name: req.name,
        type: TYPE_LABEL[req.type],
        criticality: CRITICALITY_LABEL[req.criticality],
        implementation: formatImplementation(req),
      };
      for (const col of optionalCols) {
        values[col.key] = col.render(req, nameBySlug);
      }
      const row = ws.addRow(values);

      // Indent the requirement name by its hierarchy depth to show nesting.
      row.getCell('name').alignment = { indent: depth, vertical: 'top' };
      row.getCell('criticality').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: CRITICALITY_FILL[req.criticality] },
      };
      for (const col of optionalCols) {
        if (col.wrap) {
          row.getCell(col.key).alignment = { wrapText: true, vertical: 'top' };
        }
      }
    }

    const out = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  }
}
