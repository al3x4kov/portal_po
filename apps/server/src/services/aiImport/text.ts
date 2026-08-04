import type { UnpackedDocs } from '../../lib/unpack.js';

// Secret redaction lives in one place (lib/redact.ts) so a fix to the rule can
// never leave a leaking copy behind (BE-5). Re-exported here to keep the
// module's public surface unchanged for existing importers (AiImportService).
export { sanitize } from '../../lib/redact.js';

/** Human-readable megabytes for the unpack log line (todo_16 Ф1). */
export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 0.1 ? '<0.1' : mb.toFixed(1);
}

/**
 * One-line preview of a source formulation for log lines («исходное →
 * преобразованное»): whitespace collapsed, cut at `max` chars with an ellipsis.
 */
export function shortenText(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Diagnostic for «no documentation files» (spec §4: readable, actionable):
 * instead of a mute refusal, tell the user WHAT the archive actually holds —
 * total file count, extension breakdown, and unsafe-entry count when present.
 */
export function noDocsMessage(
  stats: Pick<UnpackedDocs, 'totalEntries' | 'extensionCounts' | 'unsafeEntries'>,
): string {
  if (stats.totalEntries === 0) return 'Архив пуст.';
  const breakdown = Object.entries(stats.extensionCounts)
    .sort(([extA, countA], [extB, countB]) => countB - countA || extA.localeCompare(extB))
    .map(([ext, count]) => `${ext === '' ? '(без расширения)' : ext} — ${count}`)
    .join(', ');
  let message =
    `В архиве нет файлов документации (.md/.markdown/.txt/.json/.yaml/.yml). ` +
    `В архиве ${stats.totalEntries} файлов${breakdown ? `: ${breakdown}` : ''}.`;
  if (stats.unsafeEntries > 0) {
    message += ` Пропущено небезопасных записей: ${stats.unsafeEntries} (пути вне каталога распаковки).`;
  }
  return message;
}
