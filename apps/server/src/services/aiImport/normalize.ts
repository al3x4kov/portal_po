/**
 * todo_20 · T-203: format-aware normalization BEFORE the LLM (spec П1.3, A2).
 *
 * The extraction model works dramatically better on flat «имя — описание»
 * lines than on raw JSON/YAML/markdown tables. This module sniffs the CONTENT
 * (never the file name/extension), deterministically flattens known structures
 * and reports `expectedRecords` — the record-density heuristic used by the
 * completeness check (B5, волна 1.2). Unknown/broken structures NEVER fail:
 * the text passes through as-is (`plain`).
 */

/** Format detected by content sniffing. */
export type NormalizedFormat = 'json' | 'md-table' | 'yaml' | 'plain';

/** Outcome of the normalization of one document. */
export interface NormalizedDoc {
  /** Text to chunk and hand to the extraction call. */
  text: string;
  format: NormalizedFormat;
  /**
   * Number of records the source visibly contains (JSON records, table rows,
   * YAML keys); `null` when the density cannot be derived (plain prose).
   */
  expectedRecords: number | null;
}

/** Key names that most commonly carry a record's NAME across dialects. */
const NAME_KEYS = ['name', 'title', 'feature', 'summary', 'heading', 'id', 'key'];
/** Key names that most commonly carry a record's DESCRIPTION across dialects. */
const DESC_KEYS = ['description', 'details', 'text', 'body', 'note', 'notes', 'content'];

/** True when the line looks like a markdown table row (`| a | b |`). */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

/** True when the row is a table separator (`|---|:---:|`). */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return isTableRow(t) && /^\|(\s*:?-{2,}:?\s*\|)+$/.test(t.replace(/\s+/g, ''));
}

/** True when the line looks like a YAML `key: value` / `key:` mapping entry. */
function isYamlEntry(line: string): boolean {
  return /^\s*[-\w.«»"'а-яА-ЯёЁ ]+:\s*(\S.*)?$/.test(line) && !line.trim().startsWith('#');
}

/**
 * Sniff the document format from its CONTENT. `json` requires the text to
 * actually parse; `md-table` needs a header+separator pair; `yaml` needs a
 * front-matter marker or a majority of mapping lines.
 */
export function sniffFormat(raw: string): NormalizedFormat {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'plain';

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      /* not valid JSON — fall through */
    }
  }

  const lines = trimmed.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (isTableRow(lines[i]!) && isTableSeparator(lines[i + 1]!)) return 'md-table';
  }

  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) return 'yaml';
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length >= 2) {
    const yamlish = meaningful.filter((l) => isYamlEntry(l)).length;
    if (yamlish / meaningful.length >= 0.8 && !meaningful.some((l) => l.trim().startsWith('#')))
      return 'yaml';
  }
  return 'plain';
}

/** Depth-first collection of every array of plain objects inside a JSON value. */
function collectRecordArrays(value: unknown, out: Array<Record<string, unknown>[]>): void {
  if (Array.isArray(value)) {
    const objects = value.filter(
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
    );
    if (objects.length > 0 && objects.length === value.length) out.push(objects);
    for (const v of value) collectRecordArrays(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectRecordArrays(v, out);
  }
}

/** Pick the first present key of `keys` whose value is a non-empty scalar. */
function pickKey(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of Object.keys(record)) {
    if (keys.includes(key.toLowerCase())) {
      const v = record[key];
      if (typeof v === 'string' && v.trim().length > 0) return key;
      if (typeof v === 'number') return key;
    }
  }
  return undefined;
}

/** Flatten one JSON record into a deterministic «имя — описание (+рест)» line. */
function flattenRecord(record: Record<string, unknown>): string {
  const nameKey = pickKey(record, NAME_KEYS);
  const descKey = pickKey(record, DESC_KEYS);
  const rest = Object.entries(record)
    .filter(
      ([k, v]) =>
        k !== nameKey &&
        k !== descKey &&
        (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
    )
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('; ');
  const name = nameKey ? String(record[nameKey]) : undefined;
  const desc = descKey ? String(record[descKey]) : undefined;
  const head = name && desc ? `${name} — ${desc}` : (name ?? desc ?? '');
  const line = [head, rest].filter((p) => p.length > 0).join(' · ');
  return `- ${line}`.trimEnd();
}

/**
 * Flatten a JSON document: every array of records (any nesting, any key
 * dialect — F2b) becomes a bullet list of «имя — описание» lines. Returns
 * `null` when the document holds no record arrays (e.g. array of primitives)
 * — the caller then falls back to the raw text.
 */
function normalizeJson(raw: string): { text: string; records: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const arrays: Array<Record<string, unknown>[]> = [];
  collectRecordArrays(value, arrays);
  // Leaf-most arrays (e.g. releases[].changes[]) are also collected on their
  // own; keep only records that carry a visible name or description, and
  // de-duplicate nested containers by preferring the DEEPEST arrays.
  const leafRecords = arrays
    .flat()
    .filter((r) => pickKey(r, NAME_KEYS) !== undefined || pickKey(r, DESC_KEYS) !== undefined)
    // A container row (e.g. a release holding its own `changes` array) is not
    // a record — its children already are.
    .filter(
      (r) =>
        !Object.values(r).some((v) => Array.isArray(v) && v.some((x) => typeof x === 'object')),
    );
  if (leafRecords.length === 0) return null;
  const lines = leafRecords.map(flattenRecord);
  return { text: lines.join('\n'), records: lines.length };
}

/** Split a markdown table row into trimmed cell values. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Replace every markdown table in the document with a bullet list
 * «col1 — col2 (col3: …)». Non-table text is preserved verbatim.
 */
function normalizeMdTables(raw: string): { text: string; records: number } {
  const lines = raw.split('\n');
  const out: string[] = [];
  let records = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = splitRow(line);
      i += 1; // skip separator
      while (i + 1 < lines.length && isTableRow(lines[i + 1]!)) {
        i += 1;
        const cells = splitRow(lines[i]!);
        const name = cells[0] ?? '';
        const desc = cells[1] ?? '';
        const rest = cells
          .slice(2)
          .map((c, idx) => (c ? `${header[idx + 2] ?? `col${idx + 3}`}: ${c}` : ''))
          .filter((c) => c.length > 0)
          .join('; ');
        const head = desc ? `${name} — ${desc}` : name;
        out.push(`- ${[head, rest].filter((p) => p.length > 0).join(' · ')}`);
        records += 1;
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), records };
}

/**
 * Line-based YAML flattening: keeps `key: value` pairs (with indentation) and
 * counts mapping entries. Deliberately NOT a YAML parser — it never throws on
 * broken input and needs no new dependency.
 */
function normalizeYaml(raw: string): { text: string; records: number } {
  const lines = raw.split('\n').filter((l) => l.trim() !== '---');
  let records = 0;
  for (const line of lines) {
    if (isYamlEntry(line) && line.trim().length > 0) records += 1;
  }
  return { text: lines.join('\n'), records };
}

/**
 * Normalize one document for extraction. NEVER throws: any parse problem
 * falls back to the raw text as `plain` (spec: неизвестная структура — как
 * обычный текст, без падения).
 */
export function normalizeForExtraction(raw: string): NormalizedDoc {
  const format = sniffFormat(raw);
  if (format === 'json') {
    const flat = normalizeJson(raw);
    if (flat) return { text: flat.text, format: 'json', expectedRecords: flat.records };
    return { text: raw, format: 'json', expectedRecords: null };
  }
  if (format === 'md-table') {
    const flat = normalizeMdTables(raw);
    return { text: flat.text, format: 'md-table', expectedRecords: flat.records };
  }
  if (format === 'yaml') {
    const flat = normalizeYaml(raw);
    return {
      text: flat.text,
      format: 'yaml',
      expectedRecords: flat.records > 0 ? flat.records : null,
    };
  }
  return { text: raw, format: 'plain', expectedRecords: null };
}
