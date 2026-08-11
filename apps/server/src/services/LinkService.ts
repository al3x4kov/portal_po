import {
  assertAcyclic,
  assertNoCycle,
  assertNoSelfLink,
  assertSameType,
  assertSingleParent,
  checkMove,
  createLinkPair,
  CycleError,
  inverseLinkType,
  isHierarchyType,
  parentSlugOf,
  planMove,
  sameLink,
  SelfLinkError,
  TypeMismatchError,
  type Link,
  type LinkType,
  type Requirement,
} from '@po/core';
import type { RequirementBatchOp, RequirementRepo } from '../repositories/types.js';
import { withOpLog, type OpLogger } from '../lib/logger.js';
import { ConflictError, NotFoundError, StaleParentError } from '../lib/errors.js';
import type { LinkServicePort } from './ports.js';

export interface LinkInput {
  sourceSlug: string;
  type: LinkType;
  targetSlug: string;
}

/** «Move a row in the tree»: re-parent one requirement (FR-7 / structure mode). */
export interface MoveInput {
  childSlug: string;
  /** New parent, or `null` to lift the requirement to the root of its type. */
  newParentSlug: string | null;
  /** Parent the client believed was current; a mismatch aborts with 409. */
  expectedParentSlug?: string | null;
}

/** Outcome of a move: what changed, so the client can narrate and undo it. */
export interface MoveResult {
  childSlug: string;
  oldParentSlug: string | null;
  newParentSlug: string | null;
  /** Transitive descendants that travelled with the row. */
  movedDescendants: number;
  /** False when the requirement already hung under that parent (no write). */
  changed: boolean;
}

/**
 * Use-case layer for links (FR-8): a relationship is stored as a mutually-inverse
 * pair on both endpoints. Integrity checks (self-link, type match, single parent,
 * cycle) run before anything is written.
 */
export class LinkService implements LinkServicePort {
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

  /** Structured observability for a link mutation (ARCH-7); no-op without a logger. */
  private record<T>(op: string, slug: string, fn: () => Promise<T>): Promise<T> {
    return withOpLog(this.log, { op, projectId: this.projectId, slug }, fn);
  }

  private find(reqs: Requirement[], slug: string, role: string): Requirement {
    const req = reqs.find((r) => r.slug === slug);
    if (!req) throw new NotFoundError(`${role} requirement not found: "${slug}".`);
    return req;
  }

  /**
   * Create a link and its inverse, after enforcing all integrity rules.
   * Runs under the project lock and writes both endpoints as one atomic batch
   * (ARCH-1/2 / BE-7): a mid-way failure never leaves a one-sided link.
   */
  create({ sourceSlug, type, targetSlug }: LinkInput): Promise<void> {
    return this.record('link', sourceSlug, () =>
      this.repo.withLock(async () => {
        const { requirements } = await this.repo.loadAll();
        const source = this.find(requirements, sourceSlug, 'Source');
        const target = this.find(requirements, targetSlug, 'Target');

        assertNoSelfLink(sourceSlug, targetSlug); // SelfLinkError (422)

        if (isHierarchyType(type)) {
          assertSameType(source, target); // TypeMismatchError (422)
          if (type === 'CHILD_OF') {
            assertSingleParent(requirements, sourceSlug, targetSlug); // MultipleParentError (409)
          } else {
            assertSingleParent(requirements, targetSlug, sourceSlug);
          }
        }

        assertNoCycle(requirements, { sourceSlug, type, targetSlug }); // CycleError (409)

        const pair = createLinkPair(sourceSlug, type, targetSlug);
        if (source.links.some((l) => sameLink(l, pair.source))) {
          throw new ConflictError(
            `Link ${type} from "${sourceSlug}" to "${targetSlug}" already exists.`,
          );
        }

        const ts = this.now();
        source.links.push(pair.source);
        source.updatedAt = ts;
        target.links.push(pair.target);
        target.updatedAt = ts;

        await this.repo.applyBatch([
          { kind: 'write', req: source },
          { kind: 'write', req: target },
        ]);
      }),
    );
  }

  /** Remove a link and its inverse from both endpoints (FR-8), atomically. */
  remove({ sourceSlug, type, targetSlug }: LinkInput): Promise<void> {
    return this.record('unlink', sourceSlug, () =>
      this.repo.withLock(async () => {
        const { requirements } = await this.repo.loadAll();
        const source = this.find(requirements, sourceSlug, 'Source');
        const target = this.find(requirements, targetSlug, 'Target');

        const sourceLink: Link = { type, targetSlug };
        const targetLink: Link = { type: inverseLinkType(type), targetSlug: sourceSlug };

        const newSourceLinks = source.links.filter((l) => !sameLink(l, sourceLink));
        const newTargetLinks = target.links.filter((l) => !sameLink(l, targetLink));

        if (
          newSourceLinks.length === source.links.length &&
          newTargetLinks.length === target.links.length
        ) {
          throw new NotFoundError(
            `Link ${type} from "${sourceSlug}" to "${targetSlug}" does not exist.`,
          );
        }

        const ts = this.now();
        const batch: RequirementBatchOp[] = [];
        if (newSourceLinks.length !== source.links.length) {
          source.links = newSourceLinks;
          source.updatedAt = ts;
          batch.push({ kind: 'write', req: source });
        }
        if (newTargetLinks.length !== target.links.length) {
          target.links = newTargetLinks;
          target.updatedAt = ts;
          batch.push({ kind: 'write', req: target });
        }
        await this.repo.applyBatch(batch);
      }),
    );
  }

  /**
   * Re-parent a requirement: the ONE thing «moving a row» does to the graph.
   *
   * The old CHILD_OF/PARENT_OF pair is dropped and the new one added in a
   * single atomic batch, under the project lock — a mid-way failure never
   * leaves the row parentless or hanging under two parents. Descendants travel
   * with the row without being rewritten: their own links point at the row, not
   * at its parent.
   *
   * Sibling order is NOT stored (the tree sorts children by name), so «up» and
   * «down» are expressed by the caller as a different parent, never as a
   * position — there is nothing here to persist for ordering.
   *
   * @throws {StaleParentError} the parent on disk differs from `expectedParentSlug` (409)
   * @throws {SelfLinkError} dropping a row onto itself (422)
   * @throws {TypeMismatchError} ФТ under НФТ or vice versa (422)
   * @throws {CycleError} the target is a descendant of the row (409)
   * @throws {NotFoundError} unknown child or parent slug (404)
   */
  move({ childSlug, newParentSlug, expectedParentSlug }: MoveInput): Promise<MoveResult> {
    return this.record('move', childSlug, () =>
      this.repo.withLock(async () => {
        const { requirements } = await this.repo.loadAll();
        const child = this.find(requirements, childSlug, 'Child');
        const currentParent = parentSlugOf(child) ?? null;

        if (expectedParentSlug !== undefined && expectedParentSlug !== currentParent) {
          throw new StaleParentError(childSlug, expectedParentSlug, currentParent);
        }

        const plan = planMove(requirements, childSlug, newParentSlug);
        const block = checkMove(requirements, childSlug, newParentSlug);
        if (block) {
          switch (block.reason) {
            case 'SAME_PARENT':
              // Idempotent: repeating a move that already landed is not a failure.
              return {
                childSlug,
                oldParentSlug: currentParent,
                newParentSlug,
                movedDescendants: plan.movedDescendants.length,
                changed: false,
              };
            case 'SELF':
              throw new SelfLinkError(block.message);
            case 'TYPE_MISMATCH':
              throw new TypeMismatchError(block.message);
            case 'DESCENDANT':
              throw new CycleError([childSlug, newParentSlug as string, childSlug]);
            default:
              throw new NotFoundError(block.message);
          }
        }

        const ts = this.now();
        const batch: RequirementBatchOp[] = [];

        child.links = child.links.filter((l) => l.type !== 'CHILD_OF');
        if (newParentSlug !== null) {
          child.links.push({ type: 'CHILD_OF', targetSlug: newParentSlug });
        }
        child.updatedAt = ts;
        batch.push({ kind: 'write', req: child });

        if (currentParent !== null) {
          const oldParent = requirements.find((r) => r.slug === currentParent);
          if (oldParent) {
            oldParent.links = oldParent.links.filter(
              (l) => !(l.type === 'PARENT_OF' && l.targetSlug === childSlug),
            );
            oldParent.updatedAt = ts;
            batch.push({ kind: 'write', req: oldParent });
          }
        }

        if (newParentSlug !== null) {
          const newParent = this.find(requirements, newParentSlug, 'Parent');
          newParent.links.push({ type: 'PARENT_OF', targetSlug: childSlug });
          newParent.updatedAt = ts;
          batch.push({ kind: 'write', req: newParent });
        }

        // Belt and braces: the rebuilt graph must still be acyclic before it
        // reaches the disk (the same rule the UI enforces before the drop).
        assertAcyclic(requirements);

        await this.repo.applyBatch(batch);
        return {
          childSlug,
          oldParentSlug: currentParent,
          newParentSlug,
          movedDescendants: plan.movedDescendants.length,
          changed: true,
        };
      }),
    );
  }
}
