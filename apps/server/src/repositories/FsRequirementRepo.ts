import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse, serialize, type Requirement, type RequirementType } from '@po/core';
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

/** Folder name (under openspec/specs) that holds requirements of a given type. */
const FOLDER: Record<RequirementType, string> = {
  FUNCTION: 'functions',
  NFR: 'nfr',
};

const SPECS_DIR = path.join('openspec', 'specs');

/**
 * Filesystem repository for the OpenSpec requirement files of a single project
 * (`openspec/specs/{functions|nfr}/<slug>.md`, ADR-001). The type is derived
 * from the folder and the slug from the file name. Reads tolerate corrupt files
 * by flagging them; writes go through atomicWrite + core serialize.
 */
export class FsRequirementRepo {
  private readonly specsDir: string;

  constructor(projectsRoot: string, projectId: string) {
    this.specsDir = resolveSafe(projectsRoot, projectId, SPECS_DIR);
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
          broken.push({ file: path.join(FOLDER[type], entry.name), error: (err as Error).message });
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
}
