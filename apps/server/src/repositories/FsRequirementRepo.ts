import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  REQUIREMENT_FOLDER,
  parse,
  serialize,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { atomicWrite } from '../lib/atomicWrite.js';
import { ensureDir } from '../lib/ensureDir.js';
import { resolveSafe } from '../lib/pathSafe.js';
import { withProjectLock } from '../lib/projectLock.js';
import { NotFoundError } from '../lib/errors.js';

/** A `.md` file that could not be parsed into a valid Requirement (flagged, not fatal). */
export interface BrokenRequirement {
  /** Path relative to `openspec/specs` (e.g. `functions/foo.md`). */
  file: string;
  /** File name without the `.md` extension — occupies a slug on disk (ARCH-3). */
  slug: string;
  error: string;
}

/** Result of loading every requirement file in a project. */
export interface LoadResult {
  requirements: Requirement[];
  broken: BrokenRequirement[];
}

/**
 * A single file mutation inside a transactional batch: a `write` upserts a
 * requirement file, a `delete` removes one. Applied all-or-nothing by
 * {@link FsRequirementRepo.applyBatch}.
 */
export type RequirementBatchOp =
  { kind: 'write'; req: Requirement } | { kind: 'delete'; type: RequirementType; slug: string };

/** Internal file-level operation (absolute path; `data` absent ⇒ delete). */
interface FileOp {
  path: string;
  data?: string;
}

/** Folder name (under openspec/specs) that holds requirements of a given type. */
const FOLDER = REQUIREMENT_FOLDER;

const SPECS_DIR = path.join('openspec', 'specs');

/**
 * Filesystem repository for the OpenSpec requirement files of a single project
 * (`openspec/specs/{functions|nfr}/<slug>.md`, ADR-001). The type is derived
 * from the folder and the slug from the file name. Reads tolerate corrupt files
 * by flagging them; writes go through atomicWrite + core serialize.
 */
export class FsRequirementRepo {
  private readonly specsDir: string;

  constructor(
    private readonly projectsRoot: string,
    private readonly projectId: string,
  ) {
    this.specsDir = resolveSafe(projectsRoot, projectId, SPECS_DIR);
  }

  /**
   * Run `fn` while holding the cross-process lock for this project (ADR-003).
   * Every read-modify-write mutation goes through here so concurrent REST/MCP
   * writers serialize instead of clobbering each other (ARCH-2 / SA-8 / QA-3).
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withProjectLock(this.projectsRoot, this.projectId, fn);
  }

  private dirOf(type: RequirementType): string {
    return resolveSafe(this.specsDir, FOLDER[type]);
  }

  private fileOf(type: RequirementType, slug: string): string {
    // Guard against slugs containing path separators / traversal (S21).
    return resolveSafe(this.dirOf(type), `${slug}.md`);
  }

  /** Read + parse every requirement in both type folders; corrupt files are reported (§2.5). */
  async loadAll(): Promise<LoadResult> {
    const requirements: Requirement[] = [];
    const broken: BrokenRequirement[] = [];

    for (const type of ['FUNCTION', 'NFR'] as RequirementType[]) {
      const dir = this.dirOf(type);
      await ensureDir(dir);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = entry.name.slice(0, -'.md'.length);
        const full = path.join(dir, entry.name);
        try {
          const raw = await fs.readFile(full, 'utf8');
          requirements.push(parse(raw, { slug, type }));
        } catch (err) {
          broken.push({
            file: path.join(FOLDER[type], entry.name),
            slug,
            error: (err as Error).message,
          });
        }
      }
    }

    requirements.sort((a, b) =>
      a.type === b.type ? a.slug.localeCompare(b.slug) : a.type.localeCompare(b.type),
    );
    return { requirements, broken };
  }

  /** Create or overwrite a single requirement file atomically. */
  async write(req: Requirement): Promise<void> {
    await ensureDir(this.dirOf(req.type));
    await atomicWrite(this.fileOf(req.type, req.slug), serialize(req));
  }

  /** Delete a requirement file (identified by type + slug). */
  async delete(type: RequirementType, slug: string): Promise<void> {
    try {
      await fs.rm(this.fileOf(type, slug));
    } catch {
      throw new NotFoundError(`Requirement file not found: "${slug}" (${type}).`);
    }
  }

  /**
   * Apply a group of file mutations transactionally (ARCH-1 / BE-7).
   *
   * Multi-file operations — a link pair (source + target) or a cascading delete
   * (delete + rewrite of every neighbour) — must be all-or-nothing so a mid-way
   * crash never leaves a one-sided link or a dangling `targetSlug`. Strategy:
   * snapshot the prior state of each touched file, apply in order, and on any
   * failure roll every applied step back to its snapshot (compensation).
   */
  async applyBatch(ops: readonly RequirementBatchOp[]): Promise<void> {
    const fileOps = ops.map((op) => this.toFileOp(op));

    const snapshots = await Promise.all(
      fileOps.map(async (op): Promise<{ path: string; previous: string | null }> => {
        try {
          return { path: op.path, previous: await fs.readFile(op.path, 'utf8') };
        } catch {
          return { path: op.path, previous: null };
        }
      }),
    );

    const applied: number[] = [];
    try {
      for (let i = 0; i < fileOps.length; i += 1) {
        const op = fileOps[i]!;
        if (op.data !== undefined) {
          await this.persistFile(op.path, op.data);
        } else {
          await this.removeFile(op.path);
        }
        applied.push(i);
      }
    } catch (err) {
      // Compensate in reverse: restore prior content or remove created files.
      for (const i of applied.reverse()) {
        const snap = snapshots[i]!;
        try {
          if (snap.previous === null) {
            await fs.rm(snap.path, { force: true });
          } else {
            await atomicWrite(snap.path, snap.previous);
          }
        } catch {
          /* best-effort rollback; surface the original failure */
        }
      }
      throw err;
    }
  }

  private toFileOp(op: RequirementBatchOp): FileOp {
    if (op.kind === 'write') {
      return { path: this.fileOf(op.req.type, op.req.slug), data: serialize(op.req) };
    }
    return { path: this.fileOf(op.type, op.slug) };
  }

  /** Low-level atomic file write. `protected` so tests can inject write faults. */
  protected async persistFile(absPath: string, data: string): Promise<void> {
    await atomicWrite(absPath, data);
  }

  /** Low-level file removal. `protected` so tests can inject faults. */
  protected async removeFile(absPath: string): Promise<void> {
    await fs.rm(absPath);
  }
}
