import {
  assertUniqueName,
  cascadeUnlink,
  cascadeUnlinkSubtree,
  dedupe,
  newId,
  toSlug,
  validateRequirement,
  ValidationError,
  type AiOrigin,
  type Criticality,
  type InfoItem,
  type ProjectDictionaries,
  type Requirement,
  type RequirementType,
  type SourceEntry,
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

/**
 * Read/write port for a project's dictionaries, as consumed by the requirement
 * use case for priorityId validation (T-114) and source auto-collect (T-115).
 * {@link FsDictionariesRepo} satisfies it. Lock-free: the requirement service
 * already holds the project lock when it calls these methods.
 */
export interface RequirementDictionariesPort {
  read(): Promise<ProjectDictionaries>;
  write(dict: ProjectDictionaries): Promise<ProjectDictionaries>;
}

/**
 * Fields supplied when creating a requirement.
 *
 * `origin` (task26) is the ONE field no public client may set: the REST/MCP
 * create contract (`requirementCreateShape`) does not declare it, so a body
 * carrying it has the key stripped by Zod. Only server-side callers — the two
 * AI import populate stages — pass it, and they do so through THIS service so
 * every core rule (uniqueness, slug, validation, atomic write) still applies.
 */
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
  sources?: SourceEntry[];
  releaseDate?: string;
  /** AI provenance (task26); server-side callers only. */
  origin?: AiOrigin;
}

/**
 * Editable fields on update; `type` is immutable and therefore omitted, and so
 * is `origin` — provenance is written once, at creation (task26).
 *
 * `aiValidated` is the human-review toggle: `true`/`false` set it explicitly,
 * omitting it PRESERVES the stored value so a client that knows nothing about
 * task26 cannot silently re-raise the "not reviewed" highlight.
 */
export type RequirementUpdate = Omit<RequirementInput, 'type' | 'origin'> & {
  aiValidated?: boolean;
};

/** Drop an empty sources array so the field is present only when non-empty (like scenarios). */
function normalizeSources(sources?: SourceEntry[]): SourceEntry[] | undefined {
  return sources && sources.length > 0 ? sources : undefined;
}

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
  private readonly dictionaries?: RequirementDictionariesPort;

  constructor(
    private readonly repo: RequirementRepo,
    private readonly now: () => string = () => new Date().toISOString(),
    opts: { log?: OpLogger; projectId?: string; dictionaries?: RequirementDictionariesPort } = {},
  ) {
    this.log = opts.log;
    this.projectId = opts.projectId ?? '';
    this.dictionaries = opts.dictionaries;
  }

  /**
   * Cross-check a requirement's sources against the project dictionaries while
   * the project lock is held (T-114/T-115): reject any unknown `priorityId`
   * (422) and auto-collect never-seen source names into the source dictionary
   * (type from the entry). No-op when no dictionaries port is wired.
   */
  private async reconcileSources(sources: readonly SourceEntry[] | undefined): Promise<void> {
    if (!this.dictionaries) return;
    const entries = sources ?? [];
    const dict = await this.dictionaries.read();

    const validIds = new Set(dict.priorities.map((p) => p.id));
    for (const s of entries) {
      if (!validIds.has(s.priorityId)) {
        throw new ValidationError(`Unknown priorityId "${s.priorityId}" for source "${s.name}".`);
      }
    }

    const known = new Set(dict.sources.map((s) => s.name.trim().toLowerCase()));
    let changed = false;
    for (const s of entries) {
      const key = s.name.trim().toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      dict.sources.push({ id: newId(), name: s.name.trim(), type: s.type });
      changed = true;
    }
    if (changed) await this.dictionaries.write(dict);
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
            sources: normalizeSources(input.sources),
            releaseDate: input.releaseDate,
            // task26: an AI-created requirement starts unreviewed (no flag).
            origin: input.origin,
            links: [],
            createdAt: ts,
            updatedAt: ts,
          };
          const req = validateRequirement(candidate); // ValidationError (422)
          await this.reconcileSources(req.sources); // priorityId check + auto-collect

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
          sources: normalizeSources(input.sources),
          releaseDate: input.releaseDate,
          origin: existing.origin, // task26: provenance is immutable
          aiValidated: input.aiValidated ?? existing.aiValidated, // absent ⇒ preserve
          links: existing.links,
          createdAt: existing.createdAt,
          updatedAt: this.now(),
        };
        const req = validateRequirement(candidate);
        assertUniqueName(requirements, { slug: req.slug, type: req.type, name: req.name });
        await this.reconcileSources(req.sources); // priorityId check + auto-collect

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
