import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import {
  DomainError,
  REQUIREMENT_FOLDER,
  assertAcyclic,
  assertNoSelfLink,
  assertSingleParent,
  inverseLinkType,
  parse,
  serializeManifest,
  type ProjectManifest,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { ensureDir } from '../lib/ensureDir.js';
import { resolveSafe } from '../lib/pathSafe.js';
import { sanitizeProjectName } from '../lib/projectName.js';
import { ArchiveError, ConflictError } from '../lib/errors.js';
import { SCHEMA_VERSION } from './types.js';

export type ArchiveFormat = 'zip' | 'targz';

export interface ExportResult {
  body: Buffer | Readable;
  filename: string;
  contentType: string;
}

const MANIFEST = path.join('openspec', 'project.md');
const SPECS_DIR = path.join('openspec', 'specs');
const FOLDER = REQUIREMENT_FOLDER;
const IMPORT_TMP = '.import-tmp';

/** Detect archive format from the leading magic bytes. */
async function detectFormat(file: string): Promise<ArchiveFormat> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // "PK"
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'targz'; // gzip
    throw new ArchiveError('Unsupported archive format (expected .zip or .tar.gz).');
  } finally {
    await fh.close();
  }
}

/**
 * Repository for full-project archives (FR-3 / FR-10). Export streams a project
 * directory as zip or tar.gz; import unpacks into a temp area, validates schema
 * and link integrity, and only then atomically renames into Projects/.
 */
export class ArchiveRepo {
  constructor(private readonly projectsRoot: string) {}

  /** Stream a project directory as an archive (T-501). */
  async export(projectDir: string, format: ArchiveFormat, baseName: string): Promise<ExportResult> {
    if (format === 'zip') {
      const zip = new AdmZip();
      zip.addLocalFolder(projectDir);
      return {
        body: zip.toBuffer(),
        filename: `${baseName}.zip`,
        contentType: 'application/zip',
      };
    }
    const stream = tar.create({ gzip: true, cwd: projectDir }, ['.']) as unknown as Readable;
    return {
      body: stream,
      filename: `${baseName}.tar.gz`,
      contentType: 'application/gzip',
    };
  }

  private async extract(format: ArchiveFormat, archivePath: string, dest: string): Promise<void> {
    if (format === 'zip') {
      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const target = resolveSafe(dest, entry.entryName); // rejects traversal
        await ensureDir(path.dirname(target));
        await fs.writeFile(target, entry.getData());
      }
      return;
    }
    await tar.x({
      file: archivePath,
      cwd: dest,
      filter: (p: string) => {
        resolveSafe(dest, p); // rejects traversal inside the archive
        return true;
      },
    });
  }

  /** Find the directory that actually holds the project (flat or single nested folder). */
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

    if (await hasContent(tmpDir)) return tmpDir;

    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (dirs.length === 1) {
      const nested = resolveSafe(tmpDir, dirs[0]!.name);
      if (await hasContent(nested)) return nested;
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

  /** Parse + integrity-validate every requirement in the extracted content root. */
  private async validate(contentRoot: string): Promise<void> {
    const specsDir = path.join(contentRoot, SPECS_DIR);
    try {
      const stat = await fs.stat(specsDir);
      if (!stat.isDirectory()) throw new Error('not a dir');
    } catch {
      throw new ArchiveError('Archive has no openspec/specs directory.');
    }

    const reqs = [
      ...(await this.readTypeFolder(contentRoot, 'FUNCTION')),
      ...(await this.readTypeFolder(contentRoot, 'NFR')),
    ];

    // Links target a slug; hierarchical links are within a single type, so index by type+slug.
    const key = (type: RequirementType, slug: string): string => `${type}:${slug}`;
    const bySlug = new Map<string, Requirement>();
    for (const r of reqs) bySlug.set(key(r.type, r.slug), r);

    // Route link integrity through core/graph so the import shares the exact same
    // rules as interactive editing (BE-2). Core raises typed DomainErrors; they
    // are re-wrapped as ArchiveError so import failures map to a single code.
    try {
      for (const req of reqs) {
        for (const linkRef of req.links) {
          // Resolve the target: same type first (hierarchy), then any type (associations).
          const other =
            bySlug.get(key(req.type, linkRef.targetSlug)) ??
            reqs.find((r) => r.slug === linkRef.targetSlug && r !== req);
          if (other === req) {
            assertNoSelfLink(req.slug, linkRef.targetSlug); // SelfLinkError
          }
          if (!other) {
            throw new ArchiveError(
              `Dangling link: "${req.slug}" references missing "${linkRef.targetSlug}".`,
            );
          }
          const inverse = inverseLinkType(linkRef.type);
          const reciprocated = other.links.some(
            (l) => l.type === inverse && l.targetSlug === req.slug,
          );
          if (!reciprocated) {
            throw new ArchiveError(
              `Link from "${req.slug}" to "${linkRef.targetSlug}" is missing its inverse on the target.`,
            );
          }
        }
        // At most one parent per requirement (scoped to its own type). MultipleParentError.
        assertSingleParent(
          reqs.filter((r) => r.type === req.type),
          req.slug,
        );
      }
      // Reject hierarchy/dependency cycles across the whole graph (BE-2 gap). CycleError.
      assertAcyclic(reqs);
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      if (err instanceof DomainError) throw new ArchiveError(err.message);
      throw err;
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

    const format = await detectFormat(archivePath);
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
