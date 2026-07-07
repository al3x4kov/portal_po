import {
  assertUniqueName,
  cascadeUnlink,
  cascadeUnlinkSubtree,
  dedupe,
  toSlug,
  validateRequirement,
  type Criticality,
  type InfoItem,
  type Requirement,
  type RequirementType,
  type TargetQuarter,
  UniquenessError,
} from '@po/core';
import type {
  BrokenRequirement,
  LoadResult,
  RequirementBatchOp,
  RequirementRepo,
} from '../repositories/types.js';
import { withOpLog, type OpLogger } from '../lib/logger.js';
import { NotFoundError } from '../lib/errors.js';
import type { RequirementServicePort } from './ports.js';

/** Editable fields a client may supply when creating a requirement. */
export interface RequirementInput {
  type: RequirementType;
  name: string;
  criticality: Criticality;
  description?: string;
  implemented: boolean;
  targetQuarter?: TargetQuarter;
  targetYear?: number;
  source?: string;
  infoItems?: InfoItem[];
}

/** Editable fields on update; `type` is immutable and therefore omitted. */
export type RequirementUpdate = Omit<RequirementInput, 'type'>;

/** Result of a real-time name check (FR-6.6): availability + the slug that would be assigned. */
export interface CheckNameResult {
  available: boolean;
  /** Slug a new requirement with this name would receive (deduped across the project). */
  slug: string;
}

/**
 * Use-case layer for requirements: derives a stable slug (ADR-001), enforces
 * uniqueness (409), conditional/field validation (422), manages timestamps, and
 * performs cascading delete (FR-9).
 */
export class RequirementService implements RequirementServicePort {
  private readonly log?: OpLogger;
  private readonly projectId: string;

  constructor(
    private readonly repo: RequirementRepo,
    private readonly now: () => string = () => new Date().toISOString(),
    opts: { log?: OpLogger; projectId?: string } = {},
  ) {
    this.log = opts.log;
    this.projectId = opts.projectId ?? '';
  }

  /** Structured observability wrapper for a mutating use case (ARCH-7). */
  private record<T>(
    op: string,
    slug: string | undefined,
    fn: () => Promise<T>,
    slugOf?: (result: T) => string,
  ): Promise<T> {
    return withOpLog(this.log, { op, projectId: this.projectId, slug }, fn, slugOf);
  }

  list(): Promise<LoadResult> {
    return this.repo.loadAll();
  }

  /**
   * Every slug currently occupied on disk (dedup scope is project-wide, E8.1).
   * `type` derives from the folder, but a slug must address a requirement
   * unambiguously across both folders — so dedup considers all valid slugs AND
   * the file names of broken files (ARCH-3): a new requirement must never
   * overwrite a corrupt `<slug>.md`.
   */
  private takenSlugs(
    reqs: readonly Requirement[],
    broken: readonly BrokenRequirement[],
    excludeSlug?: string,
  ): string[] {
    return [...reqs.map((r) => r.slug), ...broken.map((b) => b.slug)].filter(
      (s) => s !== excludeSlug,
    );
  }

  /** Create a new requirement (FR-6). Serialized per project (ADR-003). */
  create(input: RequirementInput): Promise<Requirement> {
    return this.record(
      'create',
      undefined,
      () =>
        this.repo.withLock(async () => {
          const { requirements, broken } = await this.repo.loadAll();
          assertUniqueName(requirements, { type: input.type, name: input.name }); // UniquenessError (409)

          const slug = dedupe(toSlug(input.name), this.takenSlugs(requirements, broken));
          const ts = this.now();
          const candidate = {
            slug,
            type: input.type,
            name: input.name,
            criticality: input.criticality,
            description: input.description,
            implemented: input.implemented,
            targetQuarter: input.targetQuarter,
            targetYear: input.targetYear,
            source: input.source,
            infoItems: input.infoItems,
            links: [],
            createdAt: ts,
            updatedAt: ts,
          };
          const req = validateRequirement(candidate); // ValidationError (422)

          await this.repo.applyBatch([{ kind: 'write', req }]);
          return req;
        }),
      (r) => r.slug,
    );
  }

  /** Update an existing requirement (FR-6.5). slug, type and createdAt are immutable. */
  update(slug: string, input: RequirementUpdate): Promise<Requirement> {
    return this.record('update', slug, () =>
      this.repo.withLock(async () => {
        const { requirements } = await this.repo.loadAll();
        const existing = requirements.find((r) => r.slug === slug);
        if (!existing) {
          throw new NotFoundError(`Requirement not found: "${slug}".`);
        }

        const candidate = {
          slug: existing.slug, // slug is fixed at creation (immutable handle)
          type: existing.type, // type is fixed at creation
          name: input.name,
          criticality: input.criticality,
          description: input.description,
          implemented: input.implemented,
          targetQuarter: input.targetQuarter,
          targetYear: input.targetYear,
          source: input.source,
          infoItems: input.infoItems,
          links: existing.links,
          createdAt: existing.createdAt,
          updatedAt: this.now(),
        };
        const req = validateRequirement(candidate);
        assertUniqueName(requirements, { slug: req.slug, type: req.type, name: req.name });

        await this.repo.applyBatch([{ kind: 'write', req }]);
        return req;
      }),
    );
  }

  /**
   * Delete a requirement and strip every back-reference to it (FR-9.2).
   *
   * Default policy (FR-9.3): a node that still has children is rejected
   * (HasChildrenError → 409). With `{ cascade: true }` (UX-2) the node and its
   * whole subtree of descendants are removed instead, and every back-reference
   * to any removed node — hierarchical or not — is stripped from the survivors.
   *
   * The deletes and every neighbour rewrite are applied as one atomic batch
   * under the project lock (ARCH-1): a mid-cascade failure rolls back completely,
   * leaving no partially-deleted subtree and no dangling `targetSlug`. Broken
   * files are never touched (ARCH-3) — a reference from an already-corrupt file
   * is left as-is rather than crashing the delete.
   *
   * @returns the slugs that were removed (`deleted`) — one for a leaf, the whole
   *   subtree for a cascade — so callers can report the affected count.
   */
  delete(slug: string, opts: { cascade?: boolean } = {}): Promise<{ deleted: string[] }> {
    return this.record('delete', slug, () =>
      this.repo.withLock(async () => {
        const { requirements } = await this.repo.loadAll();
        const existing = requirements.find((r) => r.slug === slug);
        if (!existing) {
          throw new NotFoundError(`Requirement not found: "${slug}".`);
        }
        const bySlug = new Map(requirements.map((r) => [r.slug, r]));

        // Choose subtree cascade vs. single-node delete. cascadeUnlink throws
        // HasChildrenError (409) for a node with children when cascade is off.
        const { remaining, removed } = opts.cascade
          ? cascadeUnlinkSubtree(requirements, slug)
          : { remaining: cascadeUnlink(requirements, slug), removed: [slug] };

        // Deletes first so a mid-way write fault still compensates them back.
        const batch: RequirementBatchOp[] = removed.map((s) => ({
          kind: 'delete',
          type: (bySlug.get(s) as Requirement).type,
          slug: s,
        }));
        for (const r of remaining) {
          if (bySlug.get(r.slug) !== r) {
            batch.push({ kind: 'write', req: r });
          }
        }
        await this.repo.applyBatch(batch);
        return { deleted: removed };
      }),
    );
  }

  /** Real-time uniqueness check for the form (FR-6.6); excludes own slug on rename. */
  async checkName(
    type: RequirementType,
    name: string,
    excludeSlug?: string,
  ): Promise<CheckNameResult> {
    const { requirements, broken } = await this.repo.loadAll();
    const slug = dedupe(toSlug(name), this.takenSlugs(requirements, broken, excludeSlug));
    try {
      assertUniqueName(requirements, { slug: excludeSlug, type, name });
      return { available: true, slug };
    } catch (err) {
      if (err instanceof UniquenessError) return { available: false, slug };
      throw err;
    }
  }
}
