import {
  newId,
  type PriorityColor,
  type ProjectDictionaries,
  type Requirement,
  type SourcePriority,
  type SourceRef,
  type SourceType,
} from '@po/core';
import type { FsDictionariesRepo } from '../repositories/FsDictionariesRepo.js';
import type { RequirementBatchOp, RequirementRepo } from '../repositories/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { withOpLog, type OpLogger } from '../lib/logger.js';

/** Input for creating a priority. */
export interface AddPriorityInput {
  name: string;
  color: PriorityColor;
}

/** Patch for updating a priority (any subset). */
export interface UpdatePriorityInput {
  name?: string;
  color?: PriorityColor;
  order?: number;
}

/** Input for creating a source. */
export interface AddSourceInput {
  name: string;
  type: SourceType;
  color?: string;
}

/** Patch for updating a source (any subset). */
export interface UpdateSourceInput {
  name?: string;
  type?: SourceType;
  color?: string;
}

/** Collaborators for {@link DictionariesService}. */
export interface DictionariesServiceDeps {
  dict: FsDictionariesRepo;
  requirements: RequirementRepo;
  now?: () => string;
  log?: OpLogger;
  projectId?: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Use-case layer for the per-project dictionaries (todo_19 T-111): CRUD over
 * priorities and sources, name-uniqueness enforcement, and — on priority delete
 * — reassignment of the affected requirement sources so no requirement is left
 * pointing at a removed priorityId (NFR-4). Every mutation runs inside the
 * project lock (shared with the requirement repo) so dictionary + requirement
 * writes serialize together.
 */
export class DictionariesService {
  private readonly dict: FsDictionariesRepo;
  private readonly requirements: RequirementRepo;
  private readonly log?: OpLogger;
  private readonly projectId: string;

  constructor(deps: DictionariesServiceDeps) {
    this.dict = deps.dict;
    this.requirements = deps.requirements;
    this.log = deps.log;
    this.projectId = deps.projectId ?? '';
  }

  private record<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return withOpLog(this.log, { op, projectId: this.projectId }, fn);
  }

  /** Current dictionaries snapshot. */
  get(): Promise<ProjectDictionaries> {
    return this.dict.read();
  }

  // --- priorities ---------------------------------------------------------

  addPriority(input: AddPriorityInput): Promise<SourcePriority> {
    return this.record('addPriority', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        this.assertUniquePriorityName(dict.priorities, input.name);
        const maxOrder = dict.priorities.reduce((m, p) => Math.max(m, p.order), -1);
        const priority: SourcePriority = {
          id: newId(),
          name: input.name.trim(),
          color: input.color,
          order: maxOrder + 1,
        };
        dict.priorities.push(priority);
        await this.dict.write(dict);
        return priority;
      }),
    );
  }

  updatePriority(id: string, patch: UpdatePriorityInput): Promise<SourcePriority> {
    return this.record('updatePriority', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        const priority = dict.priorities.find((p) => p.id === id);
        if (!priority) throw new NotFoundError(`Priority not found: "${id}".`);
        if (patch.name !== undefined) {
          this.assertUniquePriorityName(dict.priorities, patch.name, id);
          priority.name = patch.name.trim();
        }
        if (patch.color !== undefined) priority.color = patch.color;
        if (patch.order !== undefined) priority.order = patch.order;
        await this.dict.write(dict);
        return priority;
      }),
    );
  }

  deletePriority(id: string, reassignTo?: string): Promise<void> {
    return this.record('deletePriority', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        const priority = dict.priorities.find((p) => p.id === id);
        if (!priority) throw new NotFoundError(`Priority not found: "${id}".`);

        // When a reassign target is supplied it must resolve to a *different*,
        // existing priority — validated up front regardless of current usage.
        if (reassignTo !== undefined) {
          if (reassignTo === id || !dict.priorities.some((p) => p.id === reassignTo)) {
            throw new NotFoundError(`Reassign target priority not found: "${reassignTo}".`);
          }
        }

        const { requirements } = await this.requirements.loadAll();
        const affected = requirements.filter((r) =>
          (r.sources ?? []).some((s) => s.priorityId === id),
        );

        if (affected.length > 0) {
          if (reassignTo === undefined) {
            throw new ConflictError(
              `Priority "${priority.name}" is used by ${affected.length} requirement(s); pass reassignTo.`,
            );
          }
          const batch: RequirementBatchOp[] = affected.map((r) => ({
            kind: 'write',
            req: this.remapSources(r, id, reassignTo),
          }));
          await this.requirements.applyBatch(batch);
        }

        dict.priorities = dict.priorities.filter((p) => p.id !== id);
        await this.dict.write(dict);
      }),
    );
  }

  private remapSources(req: Requirement, fromId: string, toId: string): Requirement {
    return {
      ...req,
      sources: (req.sources ?? []).map((s) =>
        s.priorityId === fromId ? { ...s, priorityId: toId } : s,
      ),
    };
  }

  private assertUniquePriorityName(
    priorities: readonly SourcePriority[],
    name: string,
    excludeId?: string,
  ): void {
    const key = norm(name);
    if (priorities.some((p) => p.id !== excludeId && norm(p.name) === key)) {
      throw new ConflictError(`A priority named "${name.trim()}" already exists.`);
    }
  }

  // --- sources ------------------------------------------------------------

  addSource(input: AddSourceInput): Promise<SourceRef> {
    return this.record('addSource', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        this.assertUniqueSourceName(dict.sources, input.name);
        const source: SourceRef = {
          id: newId(),
          name: input.name.trim(),
          type: input.type,
          ...(input.color ? { color: input.color } : {}),
        };
        dict.sources.push(source);
        await this.dict.write(dict);
        return source;
      }),
    );
  }

  updateSource(id: string, patch: UpdateSourceInput): Promise<SourceRef> {
    return this.record('updateSource', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        const source = dict.sources.find((s) => s.id === id);
        if (!source) throw new NotFoundError(`Source not found: "${id}".`);
        if (patch.name !== undefined) {
          this.assertUniqueSourceName(dict.sources, patch.name, id);
          source.name = patch.name.trim();
        }
        if (patch.type !== undefined) source.type = patch.type;
        if (patch.color !== undefined) source.color = patch.color;
        await this.dict.write(dict);
        return source;
      }),
    );
  }

  deleteSource(id: string): Promise<void> {
    return this.record('deleteSource', () =>
      this.requirements.withLock(async () => {
        const dict = await this.dict.read();
        if (!dict.sources.some((s) => s.id === id)) {
          throw new NotFoundError(`Source not found: "${id}".`);
        }
        dict.sources = dict.sources.filter((s) => s.id !== id);
        await this.dict.write(dict);
      }),
    );
  }

  private assertUniqueSourceName(
    sources: readonly SourceRef[],
    name: string,
    excludeId?: string,
  ): void {
    const key = norm(name);
    if (sources.some((s) => s.id !== excludeId && norm(s.name) === key)) {
      throw new ConflictError(`A source named "${name.trim()}" already exists.`);
    }
  }
}
