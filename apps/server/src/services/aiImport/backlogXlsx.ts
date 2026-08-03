import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import {
  AI_BACKLOG_MATCH_BATCH,
  AI_BACKLOG_MAX_BYTES,
  AI_BACKLOG_MAX_ROWS,
  nextQuarterOf,
  type AiBacklogColumns,
  type AiBacklogPreview,
  type TargetQuarter,
} from '@po/core';

/**
 * todo_22 · T-302: deterministic xlsx backlog reader (П2, Н1, Н6).
 *
 * Deliberately tiny: `adm-zip` (already a dependency) unpacks the OOXML
 * container, `fast-xml-parser` reads `xl/worksheets/sheet1.xml` +
 * `xl/sharedStrings.xml`. Only textual cell content is needed — shared
 * strings, inline strings and raw numeric values (`<v>`, the cached value for
 * formula/merged cells). Columns are recognized by CONTENT (key pattern,
 * target values), with headers only refining the labels — the todo_20
 * invariant «никогда только по именам». Any unreadable file yields a DATA
 * code, never an exception (Н6).
 */

/** Per-row target extracted from the file's own target column (PO decision №3). */
export interface BacklogRowTarget {
  quarter: TargetQuarter;
  year: number;
}

/** One usable backlog row (non-empty formulation). `rowId` = `r<sheet row>`. */
export interface BacklogRow {
  rowId: string;
  key?: string;
  text: string;
  target?: BacklogRowTarget;
}

export interface BacklogParseOk {
  ok: true;
  rows: BacklogRow[];
  columns: AiBacklogColumns;
  skippedRows: number;
}

export interface BacklogParseError {
  ok: false;
  code: 'DATA-02' | 'DATA-04' | 'DATA-05';
  /** Override for the registry message (file-specific detail). */
  message?: string;
}

export type BacklogParseResult = BacklogParseOk | BacklogParseError;

/** Backlog issue key: latin/cyrillic project prefix + dash + number (CRPV-155771). */
const KEY_RE = /^[A-ZА-ЯЁ][A-Z0-9А-ЯЁ]{0,9}-\d{1,10}$/iu;

/** Known header names, lower-cased (refine detection; content decides first). */
const KEY_HEADERS = new Set(['issue key', 'key', 'id', 'ключ', 'задача']);
const TEXT_HEADERS = new Set([
  'summary',
  'название',
  'тема',
  'наименование',
  'формулировка',
  'описание',
  'title',
]);
const TARGET_HEADERS = new Set([
  'due date',
  'duedate',
  'fix version',
  'fix version/s',
  'target',
  'срок',
  'дата',
  'квартал',
  'версия',
  'release',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string: numeric detection is done by regex, not by the
  // XML parser (avoids float surprises on long issue numbers).
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Text of a `<t>`-style node: plain string, `#text` wrapper or absent. */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    if (t !== undefined) return String(t as string | number);
  }
  return '';
}

/** Normalize an fast-xml-parser node into an array (absent → [], one → [one]). */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Shared strings of the workbook (`<si><t>` and rich `<si><r><t>` runs). */
function readSharedStrings(zip: AdmZip): string[] {
  const entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) return [];
  const doc: unknown = parser.parse(entry.getData().toString('utf8'));
  const sst = (doc as { sst?: { si?: unknown } }).sst;
  return asArray(sst?.si).map((si) => {
    const item = si as { t?: unknown; r?: unknown };
    if (item.r !== undefined) {
      return asArray(item.r)
        .map((run) => textOf((run as { t?: unknown }).t))
        .join('');
    }
    return textOf(item.t);
  });
}

/** Path of the FIRST sheet (workbook order); fallback to the conventional name. */
function firstSheetPath(zip: AdmZip): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  try {
    const wbEntry = zip.getEntry('xl/workbook.xml');
    const relEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
    if (!wbEntry || !relEntry) return fallback;
    const wb: unknown = parser.parse(wbEntry.getData().toString('utf8'));
    const sheets = asArray(
      (wb as { workbook?: { sheets?: { sheet?: unknown } } }).workbook?.sheets?.sheet,
    );
    const relId = (sheets[0] as { '@_r:id'?: string } | undefined)?.['@_r:id'];
    if (!relId) return fallback;
    const rels: unknown = parser.parse(relEntry.getData().toString('utf8'));
    const relationships = asArray(
      (rels as { Relationships?: { Relationship?: unknown } }).Relationships?.Relationship,
    );
    const rel = relationships.find((r) => (r as { '@_Id'?: string })['@_Id'] === relId) as
      { '@_Target'?: string } | undefined;
    const target = rel?.['@_Target'];
    if (!target) return fallback;
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  } catch {
    return fallback;
  }
}

/** Raw cell grid of the sheet: row number → column letter → resolved text. */
function readGrid(
  zip: AdmZip,
  sheetPath: string,
  shared: string[],
): Map<number, Map<string, string>> {
  const entry = zip.getEntry(sheetPath);
  if (!entry) throw new Error(`sheet not found: ${sheetPath}`);
  const doc: unknown = parser.parse(entry.getData().toString('utf8'));
  const sheetData = (doc as { worksheet?: { sheetData?: { row?: unknown } } }).worksheet?.sheetData;
  const grid = new Map<number, Map<string, string>>();
  for (const rowNode of asArray(sheetData?.row)) {
    const row = rowNode as { '@_r'?: string; c?: unknown };
    const rowNum = Number(row['@_r'] ?? NaN);
    if (!Number.isInteger(rowNum) || rowNum <= 0) continue;
    for (const cellNode of asArray(row.c)) {
      const cell = cellNode as { '@_r'?: string; '@_t'?: string; v?: unknown; is?: unknown };
      const ref = /^([A-Z]+)\d+$/.exec(cell['@_r'] ?? '');
      if (!ref) continue;
      const column = ref[1]!;
      const type = cell['@_t'];
      let value = '';
      if (type === 's') {
        const index = Number(textOf(cell.v));
        value = Number.isInteger(index) ? (shared[index] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf((cell.is as { t?: unknown } | undefined)?.t);
      } else {
        // 'str' (formula cache), 'n', 'b' or untyped — the cached `<v>` value.
        value = textOf(cell.v);
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      let cells = grid.get(rowNum);
      if (!cells) {
        cells = new Map();
        grid.set(rowNum, cells);
      }
      cells.set(column, trimmed);
    }
  }
  return grid;
}

/** Excel serial date (1900 system) → UTC milliseconds. */
function serialToUtcMs(serial: number): number {
  return Math.round((serial - 25569) * 86_400_000);
}

/**
 * Parse one cell as a target: an xlsx serial date, an ISO/RU textual date or a
 * textual quarter («Q1 2027», «2027 Q1», «1 кв. 2027»). `undefined` when the
 * value is not a target (or the year falls outside the contract 2020..2100).
 */
export function parseTargetValue(raw: string): BacklogRowTarget | undefined {
  const value = raw.trim();
  const finish = (ms: number): BacklogRowTarget | undefined => {
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (year < 2020 || year > 2100) return undefined;
    const quarter = (['Q1', 'Q2', 'Q3', 'Q4'] as const)[Math.floor(date.getUTCMonth() / 3)]!;
    return { quarter, year };
  };
  if (/^\d+(\.\d+)?$/.test(value)) {
    const serial = Number(value);
    // 2020-01-01 = 43831, 2100-12-31 = 73415 — anything else is not a date.
    if (serial >= 43831 && serial <= 73415) return finish(serialToUtcMs(serial));
    return undefined;
  }
  const quarterFirst = /^q([1-4])[\s\-./]*(20\d{2})$/i.exec(value);
  if (quarterFirst)
    return { quarter: `Q${quarterFirst[1]!}` as TargetQuarter, year: Number(quarterFirst[2]) };
  const yearFirst = /^(20\d{2})[\s\-./]*q([1-4])$/i.exec(value);
  if (yearFirst)
    return { quarter: `Q${yearFirst[2]!}` as TargetQuarter, year: Number(yearFirst[1]) };
  const ruQuarter = /^([1-4])\s*кв\w*\.?\s*(20\d{2})$/iu.exec(value);
  if (ruQuarter)
    return { quarter: `Q${ruQuarter[1]!}` as TargetQuarter, year: Number(ruQuarter[2]) };
  const iso = /^(20\d{2})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return finish(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const ru = /^(\d{2})\.(\d{2})\.(20\d{2})$/.exec(value);
  if (ru) return finish(Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1])));
  return undefined;
}

interface ColumnStats {
  column: string;
  nonEmpty: number;
  keyLike: number;
  targetLike: number;
  numericLike: number;
  textChars: number;
}

/** UI-chip label «<буква> — <заголовок>» (bare letter without a header row). */
function chipLabel(column: string, header: string | undefined): string {
  return header ? `${column} — ${header}` : column;
}

export interface ParseBacklogOptions {
  maxBytes?: number;
  maxRows?: number;
}

/**
 * Deterministic parse of a backlog xlsx buffer: recognize the key / text /
 * target columns by content, extract usable rows and count skipped ones.
 * Returns a DATA-coded outcome instead of throwing (Н6): DATA-05 — not an
 * xlsx, DATA-04 — no formulation column / empty sheet, DATA-02 — over limits.
 */
export function parseBacklogXlsx(
  buffer: Buffer,
  opts: ParseBacklogOptions = {},
): BacklogParseResult {
  const maxBytes = opts.maxBytes ?? AI_BACKLOG_MAX_BYTES;
  const maxRows = opts.maxRows ?? AI_BACKLOG_MAX_ROWS;
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      code: 'DATA-02',
      message: `Файл бэклога превышает лимит ${Math.floor(maxBytes / (1024 * 1024))} МБ.`,
    };
  }

  let grid: Map<number, Map<string, string>>;
  try {
    const zip = new AdmZip(buffer);
    const shared = readSharedStrings(zip);
    grid = readGrid(zip, firstSheetPath(zip), shared);
  } catch {
    return { ok: false, code: 'DATA-05' };
  }

  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  if (rowNumbers.length === 0) return { ok: false, code: 'DATA-04' };

  // Per-column content statistics over EVERY non-empty cell.
  const statsByColumn = new Map<string, ColumnStats>();
  for (const rowNum of rowNumbers) {
    for (const [column, value] of grid.get(rowNum)!) {
      let stats = statsByColumn.get(column);
      if (!stats) {
        stats = { column, nonEmpty: 0, keyLike: 0, targetLike: 0, numericLike: 0, textChars: 0 };
        statsByColumn.set(column, stats);
      }
      stats.nonEmpty += 1;
      if (KEY_RE.test(value)) stats.keyLike += 1;
      if (parseTargetValue(value) !== undefined) stats.targetLike += 1;
      if (/^\d+([.,]\d+)?$/.test(value)) stats.numericLike += 1;
      else stats.textChars += value.length;
    }
  }
  const allStats = [...statsByColumn.values()].sort((a, b) => a.column.localeCompare(b.column));

  // Content-first recognition: a column is the key/target column when the
  // MAJORITY of its values match (the header cell, if any, does not).
  const keyStats = allStats.find((s) => s.nonEmpty >= 1 && s.keyLike / s.nonEmpty >= 0.6);
  const targetStats = allStats.find(
    (s) => s !== keyStats && s.nonEmpty >= 1 && s.targetLike / s.nonEmpty >= 0.6,
  );
  const textStats = allStats
    .filter((s) => s !== keyStats && s !== targetStats)
    .filter((s) => s.textChars > 0 && s.numericLike / s.nonEmpty < 0.5)
    .sort((a, b) => b.textChars - a.textChars)[0];
  if (!textStats) return { ok: false, code: 'DATA-04' };

  // Header row: the first non-empty row, recognized by known header names or
  // by a key/target column whose first value does NOT match its own pattern.
  const firstRow = grid.get(rowNumbers[0]!)!;
  const headerByName = [...firstRow.values()].some((value) => {
    const name = value.trim().toLowerCase();
    return KEY_HEADERS.has(name) || TEXT_HEADERS.has(name) || TARGET_HEADERS.has(name);
  });
  const headerByContent =
    (keyStats !== undefined &&
      firstRow.has(keyStats.column) &&
      !KEY_RE.test(firstRow.get(keyStats.column)!)) ||
    (targetStats !== undefined &&
      firstRow.has(targetStats.column) &&
      parseTargetValue(firstRow.get(targetStats.column)!) === undefined);
  const hasHeader = headerByName || headerByContent;
  const headerOf = (column: string): string | undefined =>
    hasHeader ? firstRow.get(column) : undefined;

  const columns: AiBacklogColumns = {
    textColumn: chipLabel(textStats.column, headerOf(textStats.column)),
    ...(keyStats ? { keyColumn: chipLabel(keyStats.column, headerOf(keyStats.column)) } : {}),
    ...(targetStats
      ? { targetColumn: chipLabel(targetStats.column, headerOf(targetStats.column)) }
      : {}),
  };

  const dataRows = hasHeader ? rowNumbers.slice(1) : rowNumbers;
  const rows: BacklogRow[] = [];
  let skippedRows = 0;
  for (const rowNum of dataRows) {
    const cells = grid.get(rowNum)!;
    const text = (cells.get(textStats.column) ?? '').trim();
    if (text.length === 0) {
      skippedRows += 1; // service/empty row — counted, never fatal (Н6)
      continue;
    }
    const key = keyStats ? cells.get(keyStats.column) : undefined;
    const target = targetStats ? parseTargetValue(cells.get(targetStats.column) ?? '') : undefined;
    rows.push({
      rowId: `r${rowNum}`,
      text,
      ...(key !== undefined && key.length > 0 ? { key } : {}),
      ...(target ? { target } : {}),
    });
  }
  if (rows.length === 0) return { ok: false, code: 'DATA-04' };
  if (rows.length > maxRows) {
    return {
      ok: false,
      code: 'DATA-02',
      message: `В файле ${rows.length} строк бэклога — лимит ${maxRows}.`,
    };
  }
  return { ok: true, rows, columns, skippedRows };
}

/**
 * Preview + mini-estimate for the `awaiting-confirmation` screen: batches of
 * ≤{@link AI_BACKLOG_MATCH_BATCH} rows → calls; tokens are a flat heuristic
 * (batch overhead + text volume) — an ORDER of magnitude, not a promise.
 */
export function buildBacklogPreview(
  parsed: BacklogParseOk,
  fileName: string,
  nowIso: string,
): AiBacklogPreview {
  const calls = Math.ceil(parsed.rows.length / AI_BACKLOG_MATCH_BATCH);
  const textChars = parsed.rows.reduce((sum, row) => sum + row.text.length, 0);
  const next = nextQuarterOf(nowIso);
  return {
    columns: parsed.columns,
    sampleRows: parsed.rows.slice(0, 5).map((row) => ({
      rowId: row.rowId,
      text: row.text,
      ...(row.key !== undefined ? { key: row.key } : {}),
    })),
    totalRows: parsed.rows.length,
    skippedRows: parsed.skippedRows,
    estimate: { calls, tokens: calls * 800 + Math.ceil(textChars / 3) },
    fileName,
    defaultTarget: { quarter: next.targetQuarter, year: next.targetYear },
  };
}
