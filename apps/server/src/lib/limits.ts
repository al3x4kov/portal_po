import { AI_IMPORT_MAX_ARCHIVE_BYTES } from '@po/core';

/**
 * Upload & archive size limits — the single source of truth for the server
 * (ARCH-6). Every layer (Fastify body limit, multipart file-size cap, archive
 * import, AI-import, and the decompression-bomb guard in {@link ArchiveRepo}
 * and lib/unpack) reads its bound from here instead of hardcoding a number,
 * so the contract stays consistent and is easy to reason about / document.
 */

/**
 * Fastify JSON `bodyLimit` for ordinary (non-multipart) requests. Requirement
 * payloads are small markdown blobs; 5 MiB is generous and keeps a single
 * process from buffering arbitrarily large JSON bodies.
 */
export const BODY_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Maximum size of a single uploaded archive (multipart file part), enforced at
 * the STREAM boundary. Aligned to the product archive / AI-import limit so an
 * oversize upload is rejected while streaming — not after a full write to a
 * temp file — which is the ARCH-6 gap this constant closes.
 */
export const MAX_UPLOAD_BYTES = AI_IMPORT_MAX_ARCHIVE_BYTES; // 200 MiB (todo_20 Н1)

/**
 * Decompression-bomb guard applied INCREMENTALLY during unpack (ARCH-5): the
 * cumulative *uncompressed* byte total and the total entry count are checked as
 * the archive is walked, so a small compressed archive can never expand into
 * gigabytes on disk / in RAM before a limit trips. Chosen well above any
 * realistic OpenSpec project (thousands of small markdown files) yet low enough
 * to stop a bomb: 100 MiB uncompressed, 10 000 entries.
 */
export const MAX_UNPACK_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_UNPACK_ENTRIES = 10_000;

/** Incremental bomb-guard limits shared by ArchiveRepo and lib/unpack. */
export interface ArchiveLimits {
  /** Max number of file entries an archive may contain. */
  maxEntries: number;
  /** Max cumulative *uncompressed* size across all entries, in bytes. */
  maxTotalBytes: number;
}

/** Default bomb-guard limits (see {@link MAX_UNPACK_TOTAL_BYTES}). */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: MAX_UNPACK_ENTRIES,
  maxTotalBytes: MAX_UNPACK_TOTAL_BYTES,
};

/**
 * todo_20 Н1: the AI-import archive limit rose to 200 МБ compressed, so ITS
 * uncompressed bomb-guard is proportionally higher (text compresses ~5x).
 * Project archives (import/export) keep {@link DEFAULT_ARCHIVE_LIMITS} — this
 * bound applies to the AI documentation unpack only.
 */
export const AI_UNPACK_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB uncompressed

/** Bomb-guard limits of the AI documentation unpack (lib/unpack). */
export const AI_UNPACK_LIMITS: ArchiveLimits = {
  maxEntries: MAX_UNPACK_ENTRIES,
  maxTotalBytes: AI_UNPACK_TOTAL_BYTES,
};
