import {
  assertUniqueName,
  cascadeUnlink,
  newId,
  validateRequirement,
  type Criticality,
  type Requirement,
  type RequirementType,
  type TargetQuarter,
  UniquenessError,
} from '@po/core';
import { FsRequirementRepo, type LoadResult } from '../repositories/FsRequirementRepo.js';
import { NotFoundError } from '../lib/errors.js';

/** Editable fields a client may supply when creating a requirement. */
export interface RequirementInput {
  type: RequirementType;
  name: string;
  criticality: Criticality;
  description?: string;
  implemented: boolean;
  targetQuarter?: TargetQuarter;
  targetYear?: number;
}

/** Editable fields on update; `type` is immutable and therefore omitted. */
export type RequirementUpdate = Omit<RequirementInput, 'type'>;

/**
 * Use-case layer for requirements: enforces uniqueness (409), conditional/field
 * validation (422), manages id + timestamps, and performs cascading delete (FR-9).
 */
export class RequirementService {
  constructor(
    private readonly repo: FsRequirementRepo,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Promise<LoadResult> {
    return this.repo.loadAll();
  }

  /** Create a new requirement (FR-6). */
  async create(input: RequirementInput): Promise<Requirement> {
    const { requirements } = await this.repo.loadAll();
    const ts = this.now();
    const candidate = {
      id: newId(),
      type: input.type,
      name: input.name,
      criticality: input.criticality,
      description: input.description,
      implemented: input.implemented,
      targetQuarter: input.targetQuarter,
      targetYear: input.targetYear,
      links: [],
      createdAt: ts,
      updatedAt: ts,
    };
    const req = validateRequirement(candidate); // throws ValidationError (422)
    assertUniqueName(requirements, { type: req.type, name: req.name }); // throws UniquenessError (409)

    await this.repo.write(req);
    return req;
  }

  /** Update an existing requirement (FR-6.5). id, type and createdAt are immutable. */
  async update(id: string, input: RequirementUpdate): Promise<Requirement> {
    const { requirements } = await this.repo.loadAll();
    const existing = requirements.find((r) => r.id === id);
    if (!existing) {
      throw new NotFoundError(`Requirement not found: "${id}".`);
    }

    const candidate = {
      id: existing.id,
      type: existing.type, // type is fixed at creation
      name: input.name,
      criticality: input.criticality,
      description: input.description,
      implemented: input.implemented,
      targetQuarter: input.targetQuarter,
      targetYear: input.targetYear,
      links: existing.links,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };
    const req = validateRequirement(candidate);
    assertUniqueName(requirements, { id: req.id, type: req.type, name: req.name });

    await this.repo.write(req);
    return req;
  }

  /**
   * Delete a requirement and strip every back-reference to it (FR-9.2).
   * Rejected when the node still has children (HasChildrenError → 409, FR-9.3).
   */
  async delete(id: string): Promise<void> {
    const { requirements } = await this.repo.loadAll();
    const existing = requirements.find((r) => r.id === id);
    if (!existing) {
      throw new NotFoundError(`Requirement not found: "${id}".`);
    }

    const after = cascadeUnlink(requirements, id); // throws HasChildrenError (409)
    const byId = new Map(requirements.map((r) => [r.id, r]));

    await this.repo.delete(id);
    // Persist only the requirements whose links actually changed.
    for (const r of after) {
      if (byId.get(r.id) !== r) {
        await this.repo.write(r);
      }
    }
  }

  /** Real-time uniqueness check for the form (FR-6.6); excludes own id on rename. */
  async checkName(type: RequirementType, name: string, excludeId?: string): Promise<boolean> {
    const { requirements } = await this.repo.loadAll();
    try {
      assertUniqueName(requirements, { id: excludeId, type, name });
      return true;
    } catch (err) {
      if (err instanceof UniquenessError) return false;
      throw err;
    }
  }
}
