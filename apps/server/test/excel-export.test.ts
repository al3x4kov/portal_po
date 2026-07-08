import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ExportOptionalField, Requirement, SourceEntry } from '@po/core';
import { ExcelExportService } from '../src/services/ExcelExportService.js';

/** Default (all optional fields) column layout — 8 columns (Task 2). */
const HEADERS = [
  'Требование',
  'Тип',
  'Критичность',
  'Реализация',
  'Источник',
  'Описание',
  'Справочная информация',
  'Связи',
];

function req(overrides: Partial<Requirement> = {}): Requirement {
  return {
    slug: 'user-login',
    type: 'FUNCTION',
    name: 'User Login',
    criticality: 'HIGH',
    description: 'The system **SHALL** authenticate users.',
    implemented: true,
    links: [],
    createdAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:00:00.000Z',
    ...overrides,
  };
}

async function loadBack(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

function headerOf(ws: ExcelJS.Worksheet): string[] {
  const row = ws.getRow(1);
  const out: string[] = [];
  for (let c = 1; c <= (ws.columnCount || 0); c += 1) {
    out.push(String(row.getCell(c).value ?? ''));
  }
  return out;
}

/** Read data rows (row 2..end) as arrays of stringified cells across all columns. */
function dataRows(ws: ExcelJS.Worksheet): string[][] {
  const out: string[][] = [];
  const cols = ws.columnCount || 0;
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= cols; c += 1) cells.push(String(row.getCell(c).value ?? ''));
    out.push(cells);
  }
  return out;
}

describe('T5 ExcelExportService.buildWorkbook — human-readable single sheet (E15)', () => {
  it('produces a valid xlsx buffer with the ZIP (PK) signature', async () => {
    const buf = await ExcelExportService.buildWorkbook([req()]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // .xlsx is a zip container → starts with "PK\x03\x04".
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('has exactly one sheet named "Требования"', async () => {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([req()]));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Требования']);
  });

  it('writes 8 column headers in order by default (all optional fields)', async () => {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([req()]));
    expect(headerOf(wb.getWorksheet('Требования')!)).toEqual(HEADERS);
  });

  it('emits one data row per requirement', async () => {
    const reqs = [
      req({ slug: 'a', name: 'A' }),
      req({ slug: 'b', name: 'B', type: 'NFR' }),
      req({ slug: 'c', name: 'C' }),
    ];
    const wb = await loadBack(await ExcelExportService.buildWorkbook(reqs));
    const ws = wb.getWorksheet('Требования')!;
    expect(ws.rowCount).toBe(1 + reqs.length); // header + data
  });

  it('orders the FUNCTION section before the NFR section', async () => {
    const reqs = [
      req({ slug: 'nfr-1', name: 'Availability', type: 'NFR' }),
      req({ slug: 'ft-1', name: 'Login', type: 'FUNCTION' }),
    ];
    const wb = await loadBack(await ExcelExportService.buildWorkbook(reqs));
    const rows = dataRows(wb.getWorksheet('Требования')!);
    expect(rows.map((r) => r[1])).toEqual(['ФТ', 'НФТ']);
  });

  it('places a child after its parent with a greater indent (tree order + depth)', async () => {
    const reqs = [
      req({
        slug: 'parent',
        name: 'Parent',
        links: [{ type: 'PARENT_OF', targetSlug: 'child' }],
      }),
      req({
        slug: 'child',
        name: 'Child',
        links: [{ type: 'CHILD_OF', targetSlug: 'parent' }],
      }),
    ];
    const wb = await loadBack(await ExcelExportService.buildWorkbook(reqs));
    const ws = wb.getWorksheet('Требования')!;
    const rows = dataRows(ws);
    const parentIdx = rows.findIndex((r) => r[0].includes('Parent'));
    const childIdx = rows.findIndex((r) => r[0].includes('Child'));
    expect(childIdx).toBeGreaterThan(parentIdx);
    const parentIndent = ws.getRow(parentIdx + 2).getCell(1).alignment?.indent ?? 0;
    const childIndent = ws.getRow(childIdx + 2).getCell(1).alignment?.indent ?? 0;
    expect(childIndent).toBeGreaterThan(parentIndent);
  });

  it('renders type, criticality, implementation, source, info and links in words', async () => {
    const reqs = [
      req({
        slug: 'pay',
        name: 'Оплата картой',
        criticality: 'CRITICAL',
        implemented: true,
        source: 'АС21',
        infoItems: [
          { type: 'Регламент', value: 'РД-42' },
          { type: 'Владелец', value: 'Финансы' },
        ],
        links: [{ type: 'BLOCKED_BY', targetSlug: 'pci' }],
      }),
      req({
        slug: 'pci',
        name: 'Соответствие PCI DSS',
        type: 'NFR',
        criticality: 'BLOCKER',
        implemented: false,
        targetQuarter: 'Q3',
        targetYear: 2026,
        description: undefined,
        links: [
          { type: 'DEPENDS_ON', targetSlug: 'pay' },
          { type: 'RELATES_TO', targetSlug: 'pay' },
        ],
      }),
    ];
    const wb = await loadBack(await ExcelExportService.buildWorkbook(reqs));
    const ws = wb.getWorksheet('Требования')!;
    const rows = dataRows(ws);
    const payRow = rows.find((r) => r[0].includes('Оплата картой'))!;
    const pciRow = rows.find((r) => r[0].includes('PCI DSS'))!;

    // Тип
    expect(payRow[1]).toBe('ФТ');
    expect(pciRow[1]).toBe('НФТ');
    // Критичность (text, incl. Blocker)
    expect(payRow[2]).toBe('Critical');
    expect(pciRow[2]).toBe('Blocker');
    // Реализация
    expect(payRow[3]).toBe('Реализовано');
    expect(pciRow[3]).toBe('Q3 2026');
    // Источник
    expect(payRow[4]).toBe('АС21');
    expect(pciRow[4]).toBe('');
    // Описание (plain / empty)
    expect(pciRow[5]).toBe('');
    // Справочная информация — «type: value» построчно
    expect(payRow[6]).toBe('Регламент: РД-42\nВладелец: Финансы');
    expect(pciRow[6]).toBe('');
    // Связи (words + target names) — last column
    expect(payRow[7]).toBe('блокируется «Соответствие PCI DSS»');
    expect(pciRow[7]).toBe('зависит от «Оплата картой»; связана с «Оплата картой»');
  });

  it('wraps multi-line "Справочная информация" cells', async () => {
    const wb = await loadBack(
      await ExcelExportService.buildWorkbook([req({ infoItems: [{ type: 'A', value: '1' }] })]),
    );
    const ws = wb.getWorksheet('Требования')!;
    // Info is column 7 in the default layout.
    expect(ws.getRow(2).getCell(7).alignment?.wrapText).toBe(true);
  });

  it('makes the header row bold', async () => {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([req()]));
    const ws = wb.getWorksheet('Требования')!;
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
  });

  it('handles an empty project: one sheet, header only, no data rows', async () => {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([]));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Требования']);
    expect(wb.getWorksheet('Требования')!.rowCount).toBe(1);
  });
});

describe('T-202 ExcelExportService dynamic columns (field mask)', () => {
  it('emits only the 4 base columns when no optional fields are selected', async () => {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([req()], []));
    expect(headerOf(wb.getWorksheet('Требования')!)).toEqual([
      'Требование',
      'Тип',
      'Критичность',
      'Реализация',
    ]);
  });

  it('emits selected optional columns in the fixed source→description→info→links order', async () => {
    const fields: ExportOptionalField[] = ['links', 'source'];
    const wb = await loadBack(await ExcelExportService.buildWorkbook([req()], fields));
    expect(headerOf(wb.getWorksheet('Требования')!)).toEqual([
      'Требование',
      'Тип',
      'Критичность',
      'Реализация',
      'Источник',
      'Связи',
    ]);
  });

  it('keeps criticality fill and name indent regardless of the mask', async () => {
    const reqs = [
      req({ slug: 'p', name: 'P', links: [{ type: 'PARENT_OF', targetSlug: 'c' }] }),
      req({ slug: 'c', name: 'C', links: [{ type: 'CHILD_OF', targetSlug: 'p' }] }),
    ];
    const wb = await loadBack(await ExcelExportService.buildWorkbook(reqs, []));
    const ws = wb.getWorksheet('Требования')!;
    const rows = dataRows(ws);
    const parentIdx = rows.findIndex((r) => r[0].includes('P'));
    const childIdx = rows.findIndex((r) => r[0].includes('C'));
    const parentIndent = ws.getRow(parentIdx + 2).getCell(1).alignment?.indent ?? 0;
    const childIndent = ws.getRow(childIdx + 2).getCell(1).alignment?.indent ?? 0;
    expect(childIndent).toBeGreaterThan(parentIndent);
    expect(ws.getRow(2).getCell(3).fill).toBeTruthy();
  });
});

describe('todo_19 «Источник» column renders req.sources[]', () => {
  function src(name: string): SourceEntry {
    return { type: 'STAKEHOLDER', name, priorityId: 'p1' };
  }

  /** «Источник» is column 5 (1-based) in the default layout. */
  async function sourceCellOf(r: Requirement): Promise<string> {
    const wb = await loadBack(await ExcelExportService.buildWorkbook([r]));
    const ws = wb.getWorksheet('Требования')!;
    return String(ws.getRow(2).getCell(5).value ?? '');
  }

  it('joins multiple source names with «; »', async () => {
    expect(await sourceCellOf(req({ sources: [src('имя1'), src('имя2')] }))).toBe('имя1; имя2');
  });

  it('renders the legacy scalar source when sources[] is absent', async () => {
    expect(await sourceCellOf(req({ source: 'АС21' }))).toBe('АС21');
  });

  it('is empty when the requirement has neither sources[] nor source', async () => {
    expect(await sourceCellOf(req())).toBe('');
  });
});
