import { promises as fs } from 'node:fs';
import { projectDictionariesSchema, type ProjectDictionaries, type SourcePriority } from '@po/core';
import { atomicWrite } from '../lib/atomicWrite.js';
import { resolveSafe } from '../lib/pathSafe.js';

/** File name of the per-project dictionaries, resolved against the project dir. */
export const DICTIONARIES_FILENAME = 'dictionaries.json';

/** Stable id of the seeded default priority (also used as the migration default). */
export const DEFAULT_PRIORITY_ID = 'default';

/** The single default priority every project ships with (todo_19 §0.5). */
export function defaultPriority(): SourcePriority {
  return { id: DEFAULT_PRIORITY_ID, name: 'Квартальная цель', color: 'amber', order: 0 };
}

/** Fresh default dictionary content (one priority, no sources). */
export function defaultDictionaries(): ProjectDictionaries {
  return { priorities: [defaultPriority()], sources: [] };
}

/**
 * Filesystem repository for a single project's `dictionaries.json` — the ONLY
 * place that reads/writes that file (todo_19 §0.5). Reads tolerate a missing or
 * corrupt file by falling back to the default shape (without persisting); writes
 * are atomic (temp + rename) and validated through the shared Zod contract.
 * Holds no lock: callers that also mutate requirements run it inside the project
 * lock they already own (proper-lockfile is not reentrant).
 */
export class FsDictionariesRepo {
  private readonly file: string;

  constructor(projectsRoot: string, projectId: string) {
    this.file = resolveSafe(projectsRoot, projectId, DICTIONARIES_FILENAME);
  }

  /** Read the dictionaries, returning the default shape when absent/corrupt. */
  async read(): Promise<ProjectDictionaries> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return defaultDictionaries();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultDictionaries();
    }
    const result = projectDictionariesSchema.safeParse(parsed);
    return result.success ? result.data : defaultDictionaries();
  }

  /** Persist the default dictionary and return it (project creation seed). */
  async seedDefault(): Promise<ProjectDictionaries> {
    const dict = defaultDictionaries();
    await this.write(dict);
    return dict;
  }

  /** Validate and persist the dictionaries atomically. */
  async write(dict: ProjectDictionaries): Promise<ProjectDictionaries> {
    const validated = projectDictionariesSchema.parse(dict);
    await atomicWrite(this.file, JSON.stringify(validated, null, 2));
    return validated;
  }
}
