import { unpackDocsArchive, type UnpackedDocs } from '../../lib/unpack.js';
import { buildArchiveMap } from '../aiImportPrompt.js';
import { AI_IMPORT_HINT_ARCHIVE, AI_IMPORT_HINT_NO_DOCS } from './constants.js';
import { formatMb, noDocsMessage } from './text.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

export interface UnpackInput {
  archivePath: string;
  archiveBytes: number;
}

/**
 * Stage «unpack» (progress 0–5). Unzips the docs archive, warns about skipped
 * unsafe entries and fails the job with an actionable hint when the archive
 * cannot be read or holds no documentation files. `docsDir` is returned even on
 * a no-docs failure so the caller can clean it up.
 */
export type UnpackOutcome =
  | { ok: true; docsDir: string; files: string[]; archiveMap: ArchiveMap }
  | { ok: false; docsDir?: string };

export async function runUnpackStage(
  rt: AiImportRuntime,
  input: UnpackInput,
): Promise<UnpackOutcome> {
  rt.job.stage = 'unpack';
  rt.log('info', 'Распаковка архива документации…');
  // todo_16 Ф1: the size line + progress=2 are visible WHILE the archive
  // unpacks, so a large archive never looks like a hang at 0%.
  rt.log('info', `Распаковка архива (${formatMb(input.archiveBytes)} МБ)…`);
  rt.job.progress = 2;

  let unpacked: UnpackedDocs;
  try {
    unpacked = await unpackDocsArchive(input.archivePath);
  } catch (err) {
    rt.fail(`Не удалось распаковать архив: ${(err as Error).message}`, AI_IMPORT_HINT_ARCHIVE);
    return { ok: false };
  }
  const docsDir = unpacked.dir;
  if (unpacked.unsafeEntries > 0) {
    rt.log(
      'warn',
      `Пропущено небезопасных записей архива (выход за пределы каталога): ${unpacked.unsafeEntries}.`,
    );
  }

  const files = unpacked.files;
  if (files.length === 0) {
    rt.fail(noDocsMessage(unpacked), AI_IMPORT_HINT_NO_DOCS);
    return { ok: false, docsDir };
  }
  rt.log('info', `Найдено файлов документации: ${files.length}.`);
  // Built once per job: the same compact archive map goes into every
  // extraction call so the model sees the overall structure (Task 13).
  const archiveMap = buildArchiveMap(files);
  rt.job.progress = 5;
  return { ok: true, docsDir, files, archiveMap };
}
