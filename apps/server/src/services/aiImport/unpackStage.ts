import { unpackDocsArchive, type UnpackedDocs } from '../../lib/unpack.js';
import { AI_UNPACK_LIMITS } from '../../lib/limits.js';
import { buildArchiveMap } from '../aiImportPrompt.js';
import { AI_IMPORT_HINT_ARCHIVE, AI_IMPORT_HINT_NO_DOCS } from './constants.js';
import { formatMb, noDocsMessage } from './text.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

export interface UnpackInput {
  archivePath: string;
  archiveBytes: number;
  /** todo_20 T-211: unpack into the job's checkpoint dir (survives restarts). */
  destDir?: string;
}

/**
 * Stage «unpack» (progress 0–5). Unzips the docs archive, warns about skipped
 * unsafe entries and fails the job with an actionable hint when the archive
 * cannot be read or holds no documentation files. `docsDir` is returned even on
 * a no-docs failure so the caller can clean it up.
 */
export type UnpackOutcome =
  | {
      ok: true;
      docsDir: string;
      files: string[];
      archiveMap: ArchiveMap;
      /** todo_20 T-202: archive-wide stats for the inventory view. */
      totalEntries: number;
      extensionCounts: Record<string, number>;
    }
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
  // todo_23 M5: пульс не реже ~15с, пока идёт (долгая) распаковка.
  const startedMs = Date.now();
  const pulse = setInterval(() => {
    rt.log('info', `Распаковка продолжается… (${Math.round((Date.now() - startedMs) / 1000)} с)`);
  }, 15_000);
  pulse.unref?.();
  try {
    // todo_20 Н1: the AI unpack uses its own (higher) bomb-guard bound —
    // project archives keep the stricter DEFAULT_ARCHIVE_LIMITS.
    unpacked = await unpackDocsArchive(
      input.archivePath,
      undefined,
      AI_UNPACK_LIMITS,
      input.destDir,
    );
  } catch (err) {
    // T-213: every fail carries a registry code — limits are DATA-02, a broken
    // or non-archive upload is DATA-03; the raw detail stays in the message.
    const raw = (err as Error).message;
    const code = /limit|превышает/i.test(raw) ? 'DATA-02' : 'DATA-03';
    rt.failCode(code, {
      message: `Не удалось распаковать архив: ${raw}`,
      hint: AI_IMPORT_HINT_ARCHIVE,
    });
    return { ok: false };
  } finally {
    clearInterval(pulse);
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
    rt.failCode('DATA-01', { message: noDocsMessage(unpacked), hint: AI_IMPORT_HINT_NO_DOCS });
    return { ok: false, docsDir };
  }
  rt.log('info', `Найдено файлов документации: ${files.length}.`);
  // Built once per job: the same compact archive map goes into every
  // extraction call so the model sees the overall structure (Task 13).
  const archiveMap = buildArchiveMap(files);
  rt.job.progress = 5;
  return {
    ok: true,
    docsDir,
    files,
    archiveMap,
    totalEntries: unpacked.totalEntries,
    extensionCounts: unpacked.extensionCounts,
  };
}
