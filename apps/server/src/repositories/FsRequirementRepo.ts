import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse, serialize, type Requirement } from '@po/core';
import { atomicWrite } from '../lib/atomicWrite.js';
import { ensureDir } from '../lib/ensureDir.js';
import { resolveSafe } from '../lib/pathSafe.js';
import { NotFoundError } from '../lib/errors.js';

/** A `.md` file that could not be parsed into a valid Requirement (flagged, not fatal). */
export interface BrokenRequirement {
  file: string;
  error: string;
}

/** Result of loading every requirement file in a project. */
export interface LoadResult {
  requirements: Requirement[];
  broken: BrokenRequirement[];
}

/**
 * Filesystem repository for requirement `.md` files of a single project
 * (`<project>/requirements/<id>.md`). Reads tolerate corrupt files by flagging
 * them; writes go through atomicWrite + core serialize.
 */
export class FsRequirementRepo {
  private readonly reqDir: string;

  constructor(projectsRoot: string, projectId: string) {
    this.reqDir = resolveSafe(projectsRoot, projectId, 'requirements');
  }

  private fileOf(id: string): string {
    // Guard against ids containing path separators.
    return resolveSafe(this.reqDir, `${id}.md`);
  }

  /** Read and parse all requirement files; corrupt files are reported, never thrown (§2.5, FR-6.4). */
  async loadAll(): Promise<LoadResult> {
    await ensureDir(this.reqDir);
    const entries = await fs.readdir(this.reqDir, { withFileTypes: true });
    const requirements: Requirement[] = [];
    const broken: BrokenRequirement[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(this.reqDir, entry.name);
      try {
        const raw = await fs.readFile(full, 'utf8');
        requirements.push(parse(raw));
      } catch (err) {
        broken.push({ file: entry.name, error: (err as Error).message });
      }
    }
    requirements.sort((a, b) => a.id.localeCompare(b.id));
    return { requirements, broken };
  }

  /** Create or overwrite a single requirement file atomically. */
  async write(req: Requirement): Promise<void> {
    await ensureDir(this.reqDir);
    await atomicWrite(this.fileOf(req.id), serialize(req));
  }

  /** Delete a requirement file. */
  async delete(id: string): Promise<void> {
    const file = this.fileOf(id);
    try {
      await fs.rm(file);
    } catch {
      throw new NotFoundError(`Requirement file not found: "${id}".`);
    }
  }
}
