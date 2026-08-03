import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import {
  REQUIREMENT_FOLDER,
  collectImportIntegrityViolations,
  parse,
  parseManifest,
  serializeManifest,
  type ProjectManifest,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { ensureDir } from '../lib/ensureDir.js';
import { resolveSafe } from '../lib/pathSafe.js';
import { sanitizeProjectName } from '../lib/projectName.js';
import { ArchiveError, ConflictError } from '../lib/errors.js';
import { detectArchiveFormat } from '../lib/archiveFormat.js';
import type { OpLogger } from '../lib/logger.js';
import {
  SCHEMA_VERSION,
  type ArchiveFormat,
  type ArchivePort,
  type ExportResult,
} from './types.js';

export type { ArchiveFormat, ExportResult } from './types.js';

// Bomb-guard limits (ARCH-10 / QA-8) now live in lib/limits.ts — the single
// source of upload/archive limits (ARCH-6). Re-exported here for back-compat.
import { type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from '../lib/limits.js';
export { type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from '../lib/limits.js';

const MANIFEST = path.join('openspec', 'project.md');
const SPECS_DIR = path.join('openspec', 'specs');
const FOLDER = REQUIREMENT_FOLDER;
const IMPORT_TMP = '.import-tmp';
/** Per-project dictionaries file — travels with every archive so it survives export/import (todo_19). */
const DICTIONARIES = 'dictionaries.json';
/**
 * AI-import job checkpoints (todo_20 T-211, PO decision №3). Service state, not
 * a requirement/spec: NEVER exported into a project archive and IGNORED when an
 * archive that carries it is imported.
 */
const AI_JOBS_DIR = '.ai-jobs';

/** True when a (platform- or POSIX-separated) relative path is inside `.ai-jobs/`. */
function isAiJobsPath(rel: string): boolean {
  return rel.split(/[\\/]/).includes(AI_JOBS_DIR);
}

/**
 * Repository for full-project archives (FR-3 / FR-10). Export streams a project
 * directory as zip or tar.gz; import unpacks into a temp area, validates schema
 * and link integrity, and only then atomically renames into Projects/.
 */
export class ArchiveRepo implements ArchivePort {
  private readonly limits: ArchiveLimits;

  constructor(
    private readonly projectsRoot: string,
    limits: Partial<ArchiveLimits> = {},
    /**
     * Optional structured logger (BE-7): non-fatal diagnostics (e.g. a slug
     * requested for a partial export that does not exist) go here instead of
     * being written to `process.stderr` directly. Wired from the same OpLogger
     * the rest of the server uses; a no-op when absent (silent in unit tests).
     */
    private readonly log?: OpLogger,
  ) {
    this.limits = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  }

  /** Stream a project directory as an archive (T-501); `.ai-jobs/` never travels. */
  async export(projectDir: string, format: ArchiveFormat, baseName: string): Promise<ExportResult> {
    if (format === 'zip') {
      const zip = new AdmZip();
      zip.addLocalFolder(projectDir, '', (entryRel) => !isAiJobsPath(entryRel));
      return {
        body: zip.toBuffer(),
        filename: `${baseName}.zip`,
        contentType: 'application/zip',
      };
    }
    const stream = tar.create({ gzip: true, cwd: projectDir, filter: (p) => !isAiJobsPath(p) }, [
      '.',
    ]) as unknown as Readable;
    return {
      body: stream,
      filename: `${baseName}.tar.gz`,
      contentType: 'application/gzip',
    };
  }

  /**
   * Build a partial archive containing only the specified slugs + the project
   * manifest (T-523). Missing slugs are silently skipped; the manifest is
   * always included when present.
   */
  async exportSelected(
    projectDir: string,
    slugs: string[],
    format: ArchiveFormat,
    baseName: string,
  ): Promise<ExportResult> {
    // Collect candidate paths: check both type folders for each slug.
    const typeFolders = Object.values(FOLDER) as string[];
    const includePaths: Array<{ rel: string; abs: string }> = [];

    for (const slug of slugs) {
      let found = false;
      for (const folder of typeFolders) {
        const rel = path.join(SPECS_DIR, folder, `${slug}.md`);
        const abs = path.join(projectDir, rel);
        try {
          await fs.access(abs);
          includePaths.push({ rel, abs });
          found = true;
          break; // slug is unique across types (ARCH-6), stop on first hit
        } catch {
          /* file does not exist in this folder — try next */
        }
      }
      if (!found) {
        // Non-fatal: a requested slug is absent, so it is simply omitted from
        // the partial archive. Surface it through the injected logger (BE-7) —
        // pino renders an `outcome:'error'` entry at warn level — never stderr.
        this.log?.op({
          op: 'exportSelected.skipSlug',
          projectId: baseName,
          slug,
          outcome: 'error',
          code: 'NOT_FOUND',
        });
      }
    }

    // Always include manifest when it exists.
    const manifestAbs = path.join(projectDir, MANIFEST);
    let hasManifest = false;
    try {
      await fs.access(manifestAbs);
      hasManifest = true;
    } catch {
      /* no manifest — omit */
    }

    // Carry the project dictionaries alongside a partial export (todo_19).
    const dictAbs = path.join(projectDir, DICTIONARIES);
    let hasDict = false;
    try {
      await fs.access(dictAbs);
      hasDict = true;
    } catch {
      /* no dictionaries — omit */
    }

    if (format === 'zip') {
      const zip = new AdmZip();
      if (hasManifest) {
        zip.addLocalFile(manifestAbs, path.dirname(MANIFEST));
      }
      if (hasDict) {
        zip.addLocalFile(dictAbs, '');
      }
      for (const { rel, abs } of includePaths) {
        zip.addLocalFile(abs, path.dirname(rel));
      }
      return {
        body: zip.toBuffer(),
        filename: `${baseName}-partial.zip`,
        contentType: 'application/zip',
      };
    }

    // tar.gz: write files into a temp directory that mirrors the archive layout,
    // then pack it. This avoids the cwd-based API that would include everything.
    const tmpDir = path.join(
      this.projectsRoot,
      `.partial-export-${randomBytes(6).toString('hex')}`,
    );
    try {
      if (hasManifest) {
        const dest = path.join(tmpDir, MANIFEST);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(manifestAbs, dest);
      }
      if (hasDict) {
        const dest = path.join(tmpDir, DICTIONARIES);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(dictAbs, dest);
      }
      for (const { rel, abs } of includePaths) {
        const dest = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(abs, dest);
      }
      const stream = tar.create({ gzip: true, cwd: tmpDir }, ['.']) as unknown as Readable;
      // Drain the stream into a buffer so we can clean up the temp dir after.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      return {
        body: Buffer.concat(chunks),
        filename: `${baseName}-partial.tar.gz`,
        contentType: 'application/gzip',
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Pack a set of already-serialized files into an archive (T-202). Unlike
   * {@link export}/{@link exportSelected} — which copy the on-disk `.md` verbatim
   * — this path is fed content that the service produced via core `serialize()`
   * with a field mask, so the resulting archive contains only the selected
   * sections. The project manifest (`openspec/project.md`) is read from
   * `projectDir` and included when present so the archive re-imports as a
   * project. zip is packed in-memory; tar.gz uses a temp dir inside
   * PROJECTS_ROOT that is always cleaned up.
   */
  async packReserialized(
    files: ReadonlyArray<{ rel: string; content: string }>,
    projectDir: string,
    format: ArchiveFormat,
    baseName: string,
  ): Promise<ExportResult> {
    // Include the manifest verbatim when the source project has one.
    const entries = [...files];
    try {
      const manifestRaw = await fs.readFile(path.join(projectDir, MANIFEST), 'utf8');
      entries.push({ rel: MANIFEST.split(path.sep).join('/'), content: manifestRaw });
    } catch {
      /* no manifest — import synthesizes one */
    }
    // Include the project dictionaries verbatim so a reserialized (field-masked)
    // archive stays entry-for-entry equal to the full copy and re-imports with
    // its priorities/sources intact (todo_19).
    try {
      const dictRaw = await fs.readFile(path.join(projectDir, DICTIONARIES), 'utf8');
      entries.push({ rel: DICTIONARIES, content: dictRaw });
    } catch {
      /* no dictionaries file — nothing to carry */
    }

    if (format === 'zip') {
      const zip = new AdmZip();
      for (const { rel, content } of entries) {
        zip.addFile(rel.split(path.sep).join('/'), Buffer.from(content, 'utf8'));
      }
      return {
        body: zip.toBuffer(),
        filename: `${baseName}.zip`,
        contentType: 'application/zip',
      };
    }

    const tmpDir = resolveSafe(this.projectsRoot, `.reserialize-${randomBytes(6).toString('hex')}`);
    try {
      for (const { rel, content } of entries) {
        const dest = resolveSafe(tmpDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }
      const stream = tar.create({ gzip: true, cwd: tmpDir }, ['.']) as unknown as Readable;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      return {
        body: Buffer.concat(chunks),
        filename: `${baseName}.tar.gz`,
        contentType: 'application/gzip',
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async extract(format: ArchiveFormat, archivePath: string, dest: string): Promise<void> {
    // Cumulative bomb-guard counters shared across the whole archive.
    let entries = 0;
    let totalBytes = 0;
    const account = (bytes: number): void => {
      entries += 1;
      totalBytes += bytes;
      if (entries > this.limits.maxEntries) {
        throw new ArchiveError(`Archive has too many entries (limit ${this.limits.maxEntries}).`);
      }
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new ArchiveError(
          `Archive exceeds the uncompressed size limit (${this.limits.maxTotalBytes} bytes).`,
        );
      }
    };

    if (format === 'zip') {
      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        // todo_20 T-211: foreign `.ai-jobs/` payload is service state of another
        // installation — silently ignored, never written into the new project.
        if (isAiJobsPath(entry.entryName)) continue;
        account(entry.header.size); // uncompressed size, checked before writing
        const target = resolveSafe(dest, entry.entryName); // rejects traversal
        await ensureDir(path.dirname(target));
        await fs.writeFile(target, entry.getData());
      }
      return;
    }
    // node-tar surfaces a throw from `filter` as an *uncaught* stream error, so
    // we capture the first violation, skip the offending entry, and re-throw
    // once extraction settles — nothing unsafe is ever written to disk.
    let violation: Error | null = null;
    await tar.x({
      file: archivePath,
      cwd: dest,
      filter: (p: string, entry: { size?: number }): boolean => {
        if (violation) return false;
        if (isAiJobsPath(p)) return false; // todo_20 T-211: ignore foreign checkpoints
        try {
          resolveSafe(dest, p); // rejects traversal inside the archive
          account(entry.size ?? 0); // rejects bomb (entries / uncompressed size)
        } catch (err) {
          violation = err as Error;
          return false;
        }
        return true;
      },
    });
    if (violation) throw violation;
  }

  /**
   * Find the directory that actually holds the project (task22).
   *
   * Archives zipped "as a folder" (Finder, GitHub/Gitea release downloads)
   * put everything under one root wrapper dir, sometimes several levels
   * deep. Starting at the extraction root, while `openspec/` is absent and
   * the current dir contains exactly one real subdirectory (service entries
   * like `__MACOSX` and dot-entries are ignored), descend into it — at most
   * {@link ArchiveRepo.MAX_WRAPPER_DEPTH} levels. Descent only follows
   * directories physically extracted under the temp dir (`resolveSafe`), so
   * path-traversal defenses (NFR-5) are untouched. If `openspec/` is never
   * found the extraction root is returned and `validate()` reports the
   * expected structure.
   */
  private static readonly MAX_WRAPPER_DEPTH = 3;
  private static readonly IGNORED_ROOT_ENTRIES = new Set(['__MACOSX']);

  private async locateContentRoot(tmpDir: string): Promise<string> {
    const hasContent = async (dir: string): Promise<boolean> => {
      try {
        await fs.access(path.join(dir, MANIFEST));
        return true;
      } catch {
        /* no manifest */
      }
      try {
        const stat = await fs.stat(path.join(dir, SPECS_DIR));
        return stat.isDirectory();
      } catch {
        return false;
      }
    };

    let current = tmpDir;
    for (let depth = 0; depth <= ArchiveRepo.MAX_WRAPPER_DEPTH; depth++) {
      if (await hasContent(current)) return current;
      const entries = await fs.readdir(current, { withFileTypes: true });
      const dirs = entries.filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          !ArchiveRepo.IGNORED_ROOT_ENTRIES.has(e.name),
      );
      if (dirs.length !== 1) break; // ambiguous or empty — stop descending
      current = resolveSafe(current, dirs[0]!.name);
    }
    return tmpDir;
  }

  private async readTypeFolder(contentRoot: string, type: RequirementType): Promise<Requirement[]> {
    const dir = path.join(contentRoot, SPECS_DIR, FOLDER[type]);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    const reqs: Requirement[] = [];
    for (const f of files) {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const slug = f.slice(0, -'.md'.length);
      try {
        reqs.push(parse(raw, { slug, type }));
      } catch (err) {
        throw new ArchiveError(
          `Invalid requirement file "${path.join(FOLDER[type], f)}": ${(err as Error).message}`,
        );
      }
    }
    return reqs;
  }

  /**
   * Reject an archive whose manifest declares an unknown (future) schemaVersion
   * before anything is committed (ARCH-5 / SA-9). A missing manifest is fine —
   * {@link ensureManifest} synthesizes a current-version one. A malformed or
   * too-new manifest raises {@link ArchiveError} so import fails and the target
   * directory is never created.
   */
  private async validateManifest(contentRoot: string): Promise<void> {
    const manifestPath = path.join(contentRoot, MANIFEST);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      return; // no manifest — ensureManifest will write a current-version one
    }
    try {
      parseManifest(raw); // enforces schemaVersion <= SCHEMA_VERSION
    } catch (err) {
      throw new ArchiveError(`Unsupported or invalid project manifest: ${(err as Error).message}`);
    }
  }

  /** Parse + integrity-validate every requirement in the extracted content root. */
  private async validate(contentRoot: string): Promise<void> {
    await this.validateManifest(contentRoot);

    const specsDir = path.join(contentRoot, SPECS_DIR);
    try {
      const stat = await fs.stat(specsDir);
      if (!stat.isDirectory()) throw new Error('not a dir');
    } catch {
      throw new ArchiveError(
        'Archive must contain an openspec/ directory with project.md and specs/ ' +
          '(optionally inside a single wrapper folder, e.g. MyProject/openspec/...).',
      );
    }

    const reqs = [
      ...(await this.readTypeFolder(contentRoot, 'FUNCTION')),
      ...(await this.readTypeFolder(contentRoot, 'NFR')),
    ];

    // Project-wide slug uniqueness (ARCH-6): create() dedups slugs across the
    // whole project, so a slug must be unique across BOTH type folders. Reject a
    // cross-type collision (e.g. functions/x.md + nfr/x.md) that a type:slug
    // index would otherwise silently accept and that would make links ambiguous.
    const seenSlugs = new Set<string>();
    for (const r of reqs) {
      if (seenSlugs.has(r.slug)) {
        throw new ArchiveError(`Duplicate slug "${r.slug}" across requirement types.`);
      }
      seenSlugs.add(r.slug);
    }

    // Route link-graph integrity through core so the import shares the EXACT
    // same 2.4 invariants as interactive editing (BE-2 / SA-3). The collector
    // gathers EVERY breach (cycle, second parent, dangling target, self-link,
    // missing inverse) instead of failing fast, so the caller can reject with
    // the full list of concrete violations. Rejection is atomic: the target dir
    // is never created and the temp is swept (FR-3.4).
    const violations = collectImportIntegrityViolations(reqs);
    if (violations.length > 0) {
      throw new ArchiveError(
        `Archive link graph violates integrity invariants (${violations.length} issue(s)).`,
        violations.map((v) => v.message),
      );
    }
  }

  /** Ensure the imported project carries a manifest (synthesize one if absent). */
  private async ensureManifest(contentRoot: string, name: string): Promise<void> {
    const manifestPath = path.join(contentRoot, MANIFEST);
    try {
      await fs.access(manifestPath);
    } catch {
      const manifest: ProjectManifest = {
        name,
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      };
      await ensureDir(path.dirname(manifestPath));
      await fs.writeFile(manifestPath, serializeManifest(manifest));
    }
  }

  /**
   * Import an archive into a new project (T-502). Atomic: on any failure the temp
   * area is removed and the target directory is never created (FR-3.4).
   */
  async import(archivePath: string, rawName: string): Promise<string> {
    await ensureDir(this.projectsRoot); // FR-3.2 recreate Projects/

    const id = sanitizeProjectName(rawName);
    const targetDir = resolveSafe(this.projectsRoot, id);
    if (await this.dirExists(targetDir)) {
      throw new ConflictError(`A project named "${id}" already exists.`);
    }

    const format = await detectArchiveFormat(archivePath);
    const tmpParent = resolveSafe(this.projectsRoot, IMPORT_TMP);
    await ensureDir(tmpParent);
    const tmpDir = resolveSafe(tmpParent, randomBytes(10).toString('hex'));
    await ensureDir(tmpDir);

    try {
      await this.extract(format, archivePath, tmpDir);
      const contentRoot = await this.locateContentRoot(tmpDir);
      await this.validate(contentRoot);
      await this.ensureManifest(contentRoot, id);
      await fs.rename(contentRoot, targetDir); // atomic commit
      return id;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async dirExists(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
