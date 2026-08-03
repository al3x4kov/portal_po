import {
  AI_IMPORT_SOURCE_CLASSES,
  type AiImportInventoryView,
  type AiImportReportView,
  type AiImportSourceClass,
} from '@po/core';

/**
 * todo_20 · T-213: the final quality report (spec П6.5, E4), built INCREMENTALLY
 * during the run so a `failed`/`cancelled` job still carries a (partial) report.
 *
 * Coverage is per source class (files inventoried vs processed, extracted
 * ФТ/НФТ, chunks that needed a repeat pass); blind spots collect everything the
 * PO must know was NOT analyzed: excluded files (with reasons), skipped
 * unparsable chunks and truncated answers.
 */

interface CoverageRow {
  files: number;
  processedFiles: number;
  extractedFunctions: number;
  extractedNfrs: number;
  retriedChunks: number;
}

const emptyRow = (): CoverageRow => ({
  files: 0,
  processedFiles: 0,
  extractedFunctions: 0,
  extractedNfrs: 0,
  retriedChunks: 0,
});

export class ReportBuilder {
  private readonly rows = new Map<AiImportSourceClass, CoverageRow>();
  private excluded: Array<{ message: string; count: number }> = [];
  private skippedChunks = 0;
  private truncatedAnswers = 0;

  /** Restore the builder from a persisted report view (resume, T-212). */
  static fromView(view: AiImportReportView): ReportBuilder {
    const builder = new ReportBuilder();
    for (const row of view.coverage) {
      builder.rows.set(row.sourceClass, {
        files: row.files,
        processedFiles: row.processedFiles,
        extractedFunctions: row.extractedFunctions,
        extractedNfrs: row.extractedNfrs,
        retriedChunks: row.retriedChunks,
      });
    }
    for (const spot of view.blindSpots) {
      if (spot.kind === 'excluded') {
        builder.excluded.push({ message: spot.message, count: spot.count });
      } else if (spot.kind === 'skipped-file') {
        builder.skippedChunks += spot.count;
      } else {
        builder.truncatedAnswers += spot.count;
      }
    }
    return builder;
  }

  /** Seed the report from the inventory (files per class + exclusions). */
  static fromInventory(inventory: AiImportInventoryView): ReportBuilder {
    const builder = new ReportBuilder();
    for (const cls of AI_IMPORT_SOURCE_CLASSES) {
      const files = inventory.processed[cls];
      if (files !== undefined && files > 0) builder.row(cls).files = files;
    }
    builder.excluded = inventory.excluded.map((e) => ({
      message: `${e.path} — ${e.reason}`,
      count: e.count,
    }));
    return builder;
  }

  private row(cls: AiImportSourceClass): CoverageRow {
    let row = this.rows.get(cls);
    if (!row) {
      row = emptyRow();
      this.rows.set(cls, row);
    }
    return row;
  }

  /** A file of the class was fully analyzed. */
  noteFileProcessed(cls: AiImportSourceClass): void {
    this.row(cls).processedFiles += 1;
  }

  /** Records extracted from one committed chunk of the class. */
  noteExtracted(cls: AiImportSourceClass, functions: number, nfrs: number): void {
    const row = this.row(cls);
    row.extractedFunctions += functions;
    row.extractedNfrs += nfrs;
  }

  /** Chunks re-run by the completeness pass (T-207 B5). */
  noteRetriedChunks(cls: AiImportSourceClass, count: number): void {
    this.row(cls).retriedChunks += count;
  }

  /** A chunk was skipped: the model never returned a parsable answer for it. */
  noteSkippedChunk(): void {
    this.skippedChunks += 1;
  }

  /** A model answer was truncated by the token limit (potential blind spot). */
  noteTruncated(): void {
    this.truncatedAnswers += 1;
  }

  /** The client-facing report view (assign to `job.report` after each change). */
  view(): AiImportReportView {
    const coverage = AI_IMPORT_SOURCE_CLASSES.filter((cls) => this.rows.has(cls)).map((cls) => ({
      sourceClass: cls,
      ...this.rows.get(cls)!,
    }));
    const blindSpots: AiImportReportView['blindSpots'] = [];
    for (const entry of this.excluded) {
      blindSpots.push({ kind: 'excluded', message: entry.message, count: entry.count });
    }
    if (this.skippedChunks > 0) {
      blindSpots.push({
        kind: 'skipped-file',
        message: 'Фрагменты пропущены: модель не вернула распознаваемый ответ.',
        count: this.skippedChunks,
      });
    }
    if (this.truncatedAnswers > 0) {
      blindSpots.push({
        kind: 'truncated',
        message: 'Ответы модели обрезаны по лимиту токенов — часть записей могла потеряться.',
        count: this.truncatedAnswers,
      });
    }
    return { coverage, blindSpots };
  }
}
