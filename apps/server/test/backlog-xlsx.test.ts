import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  buildBacklogPreview,
  parseBacklogXlsx,
  parseTargetValue,
} from '../src/services/aiImport/backlogXlsx.js';
import { backlogXlsxBuffer } from './aiImportKit.js';
import { fixedNow } from './helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Excel 1900-system serial for a UTC date. */
function serialOf(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / 86_400_000 + 25569;
}

type Cell = string | number | undefined;

/** Shared synthetic builder (aiImportKit); the real-dialect case is the fixture. */
const makeXlsx = (rows: Cell[][], opts: { inline?: boolean } = {}): Buffer =>
  backlogXlsxBuffer(rows, opts);

describe('T-302 · xlsx backlog reader', () => {
  it('parses the reference Jira queryTable export (Книга2.xlsx)', async () => {
    const buffer = await fs.readFile(path.join(FIXTURES, 'Книга2.xlsx'));
    const result = parseBacklogXlsx(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.keyColumn).toBe('A — Issue key');
    expect(result.columns.textColumn).toBe('B — Summary');
    expect(result.columns.targetColumn).toBeUndefined();
    expect(result.rows.length).toBeGreaterThan(200);
    // Every non-empty row is read, every key extracted in the CRPV-* format.
    for (const row of result.rows) {
      expect(row.key).toMatch(/^CRPV-\d+$/);
      expect(row.text.length).toBeGreaterThan(0);
    }
    expect(new Set(result.rows.map((r) => r.rowId)).size).toBe(result.rows.length);
  });

  it('reads inline strings and skips empty rows with a counter', () => {
    const buffer = makeXlsx(
      [
        ['Issue key', 'Summary'],
        ['AB-1', 'Первая формулировка'],
        [undefined, undefined],
        ['AB-2', ''],
        ['AB-3', 'Третья формулировка'],
      ],
      { inline: true },
    );
    const result = parseBacklogXlsx(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.rowId)).toEqual(['r2', 'r5']);
    expect(result.skippedRows).toBe(1); // r4 had content but no formulation
  });

  it('works without a key column (bare formulations, no header)', () => {
    const buffer = makeXlsx([['Сделать выгрузку отчёта'], ['Ускорить поиск по каталогу']]);
    const result = parseBacklogXlsx(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.keyColumn).toBeUndefined();
    expect(result.columns.textColumn).toBe('A');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.key).toBeUndefined();
  });

  it('extracts per-row targets from serial dates and textual quarters', () => {
    const buffer = makeXlsx([
      ['Issue key', 'Summary', 'Due date'],
      ['AB-1', 'Формулировка один', serialOf(2027, 2, 10)],
      ['AB-2', 'Формулировка два', 'Q1 2027'],
      ['AB-3', 'Формулировка три', undefined],
    ]);
    const result = parseBacklogXlsx(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.targetColumn).toBe('C — Due date');
    expect(result.rows[0]!.target).toEqual({ quarter: 'Q1', year: 2027 });
    expect(result.rows[1]!.target).toEqual({ quarter: 'Q1', year: 2027 });
    expect(result.rows[2]!.target).toBeUndefined();
  });

  it('recognizes Cyrillic headers and swapped columns by content', () => {
    const buffer = makeXlsx([
      ['Название', 'Ключ'],
      ['Печать накладной со склада', 'СКЛ-101'],
      ['Импорт остатков из файла', 'СКЛ-102'],
    ]);
    const result = parseBacklogXlsx(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.keyColumn).toBe('B — Ключ');
    expect(result.columns.textColumn).toBe('A — Название');
    expect(result.rows[0]).toMatchObject({ key: 'СКЛ-101', text: 'Печать накладной со склада' });
  });

  it('DATA-05 on a broken zip and on a non-xlsx file', () => {
    expect(parseBacklogXlsx(Buffer.from('это вовсе не архив', 'utf8'))).toMatchObject({
      ok: false,
      code: 'DATA-05',
    });
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no sheets here'));
    expect(parseBacklogXlsx(zip.toBuffer())).toMatchObject({ ok: false, code: 'DATA-05' });
  });

  it('DATA-04 on an empty sheet and on a sheet without a text column', () => {
    expect(parseBacklogXlsx(makeXlsx([]))).toMatchObject({ ok: false, code: 'DATA-04' });
    expect(
      parseBacklogXlsx(
        makeXlsx([
          [1, 2],
          [3, 4],
        ]),
      ),
    ).toMatchObject({
      ok: false,
      code: 'DATA-04',
    });
    // Header only, zero data rows → still «нет формулировок».
    expect(parseBacklogXlsx(makeXlsx([['Issue key', 'Summary']]))).toMatchObject({
      ok: false,
      code: 'DATA-04',
    });
  });

  it('DATA-02 on row and byte limits', () => {
    const many: Cell[][] = [['Issue key', 'Summary']];
    for (let i = 1; i <= 11; i++) many.push([`AB-${i}`, `Формулировка ${i}`]);
    expect(parseBacklogXlsx(makeXlsx(many), { maxRows: 10 })).toMatchObject({
      ok: false,
      code: 'DATA-02',
    });
    expect(parseBacklogXlsx(makeXlsx(many), { maxBytes: 16 })).toMatchObject({
      ok: false,
      code: 'DATA-02',
    });
  });

  it('parseTargetValue: dates in range, quarters, and garbage', () => {
    expect(parseTargetValue(String(serialOf(2026, 12, 31)))).toEqual({ quarter: 'Q4', year: 2026 });
    expect(parseTargetValue('2027-05-20')).toEqual({ quarter: 'Q2', year: 2027 });
    expect(parseTargetValue('20.08.2027')).toEqual({ quarter: 'Q3', year: 2027 });
    expect(parseTargetValue('2 кв. 2027')).toEqual({ quarter: 'Q2', year: 2027 });
    expect(parseTargetValue('2027 Q3')).toEqual({ quarter: 'Q3', year: 2027 });
    expect(parseTargetValue('обычный текст')).toBeUndefined();
    expect(parseTargetValue('123')).toBeUndefined(); // serial out of the date range
    expect(parseTargetValue(String(serialOf(2101, 1, 1)))).toBeUndefined();
  });

  it('builds a preview with ≤5 samples, batch estimate and the next-quarter default', () => {
    const rows: Cell[][] = [['Issue key', 'Summary']];
    for (let i = 1; i <= 45; i++) rows.push([`AB-${i}`, `Формулировка номер ${i}`]);
    const parsed = parseBacklogXlsx(makeXlsx(rows));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const preview = buildBacklogPreview(parsed, 'backlog.xlsx', fixedNow());
    expect(preview.sampleRows).toHaveLength(5);
    expect(preview.totalRows).toBe(45);
    expect(preview.estimate.calls).toBe(3); // ceil(45 / 20)
    expect(preview.estimate.tokens).toBeGreaterThan(0);
    expect(preview.fileName).toBe('backlog.xlsx');
    expect(preview.defaultTarget.year).toBeGreaterThanOrEqual(2020);
    expect(['Q1', 'Q2', 'Q3', 'Q4']).toContain(preview.defaultTarget.quarter);
  });
});
