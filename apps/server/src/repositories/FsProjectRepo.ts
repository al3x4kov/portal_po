import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../lib/atomicWrite.js';
import { ensureDir } from '../lib/ensureDir.js';
import { assertRealpathWithin, resolveSafe } from '../lib/pathSafe.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { sanitizeProjectName } from '../lib/projectName.js';
import { ProjectManifest, ProjectSummary, SCHEMA_VERSION } from './types.js';

const MANIFEST = 'project.json';
const REQUIREMENTS_DIR = 'requirements';

/**
 * Filesystem repository for projects: every project is a directory under the
 * Projects/ root containing a `project.json` manifest and a `requirements/`
 * folder. All path resolution is funnelled through {@link resolveSafe}.
 */
export class FsProjectRepo {
  constructor(private readonly projectsRoot: string) {}

  /** Recreate Projects/ if it was removed (FR-2.3 / FR-3.2). */
  async ensureRoot(): Promise<void> {
    await ensureDir(this.projectsRoot);
  }

  private dirOf(id: string): string {
    return resolveSafe(this.projectsRoot, id);
  }

  private async readManifest(dir: string): Promise<ProjectManifest | null> {
    try {
      const raw = await fs.readFile(path.join(dir, MANIFEST), 'utf8');
      return JSON.parse(raw) as ProjectManifest;
    } catch {
      return null;
    }
  }

  private async summaryOf(id: string, dir: string): Promise<ProjectSummary> {
    const manifest = await this.readManifest(dir);
    return {
      id,
      name: manifest?.name ?? id,
      mainPath: dir,
      createdAt: manifest?.createdAt ?? new Date(0).toISOString(),
    };
  }

  /** List all project directories (FR-4.1). Hidden/dot directories are skipped. */
  async list(): Promise<ProjectSummary[]> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = this.dirOf(entry.name);
      summaries.push(await this.summaryOf(entry.name, dir));
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  async exists(id: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.dirOf(id));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /** Open an existing project (FR-4.2 / FR-5.1). */
  async get(id: string): Promise<ProjectSummary> {
    const dir = this.dirOf(id);
    if (!(await this.exists(id))) {
      throw new NotFoundError(`Project not found: "${id}".`);
    }
    return this.summaryOf(id, dir);
  }

  /**
   * Create a new project directory (FR-2). Recreates Projects/ when missing,
   * sanitizes the name, rejects duplicates with a 409.
   */
  async create(rawName: string, now: () => string = () => new Date().toISOString()): Promise<ProjectSummary> {
    await this.ensureRoot();
    const id = sanitizeProjectName(rawName);
    const dir = this.dirOf(id);
    await assertRealpathWithin(this.projectsRoot, dir);

    if (await this.exists(id)) {
      throw new ConflictError(`A project named "${id}" already exists.`);
    }

    await ensureDir(dir);
    await ensureDir(path.join(dir, REQUIREMENTS_DIR));
    const manifest: ProjectManifest = {
      name: rawName.trim() || id,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now(),
    };
    await atomicWrite(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    return this.summaryOf(id, dir);
  }
}
