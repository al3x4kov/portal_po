import {
  assertNoCycle,
  assertNoSelfLink,
  assertSameType,
  assertSingleParent,
  createLinkPair,
  inverseLinkType,
  type Link,
  type LinkType,
  type Requirement,
} from '@po/core';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';

export interface LinkInput {
  sourceId: string;
  type: LinkType;
  targetId: string;
}

const isHierarchy = (t: LinkType): boolean => t === 'PARENT_OF' || t === 'CHILD_OF';
const sameLink = (a: Link, b: Link): boolean => a.type === b.type && a.targetId === b.targetId;

/**
 * Use-case layer for links (FR-8): a relationship is stored as a mutually-inverse
 * pair on both endpoints. Integrity checks (self-link, type match, single parent,
 * cycle) run before anything is written.
 */
export class LinkService {
  constructor(
    private readonly repo: FsRequirementRepo,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private find(reqs: Requirement[], id: string, role: string): Requirement {
    const req = reqs.find((r) => r.id === id);
    if (!req) throw new NotFoundError(`${role} requirement not found: "${id}".`);
    return req;
  }

  /** Create a link and its inverse, after enforcing all integrity rules. */
  async create({ sourceId, type, targetId }: LinkInput): Promise<void> {
    const { requirements } = await this.repo.loadAll();
    const source = this.find(requirements, sourceId, 'Source');
    const target = this.find(requirements, targetId, 'Target');

    assertNoSelfLink(sourceId, targetId); // SelfLinkError (422)

    if (isHierarchy(type)) {
      assertSameType(source, target); // TypeMismatchError (422)
      // Determine which node gains a parent and verify it stays single-parent.
      if (type === 'CHILD_OF') {
        assertSingleParent(requirements, sourceId, targetId); // MultipleParentError (409)
      } else {
        assertSingleParent(requirements, targetId, sourceId);
      }
    }

    assertNoCycle(requirements, { sourceId, type, targetId }); // CycleError (409)

    const pair = createLinkPair(sourceId, type, targetId);
    if (source.links.some((l) => sameLink(l, pair.source))) {
      throw new ConflictError(`Link ${type} from "${sourceId}" to "${targetId}" already exists.`);
    }

    const ts = this.now();
    source.links.push(pair.source);
    source.updatedAt = ts;
    target.links.push(pair.target);
    target.updatedAt = ts;

    await this.repo.write(source);
    await this.repo.write(target);
  }

  /** Remove a link and its inverse from both endpoints (FR-8). */
  async remove({ sourceId, type, targetId }: LinkInput): Promise<void> {
    const { requirements } = await this.repo.loadAll();
    const source = this.find(requirements, sourceId, 'Source');
    const target = this.find(requirements, targetId, 'Target');

    const sourceLink: Link = { type, targetId };
    const targetLink: Link = { type: inverseLinkType(type), targetId: sourceId };

    const newSourceLinks = source.links.filter((l) => !sameLink(l, sourceLink));
    const newTargetLinks = target.links.filter((l) => !sameLink(l, targetLink));

    if (
      newSourceLinks.length === source.links.length &&
      newTargetLinks.length === target.links.length
    ) {
      throw new NotFoundError(`Link ${type} from "${sourceId}" to "${targetId}" does not exist.`);
    }

    const ts = this.now();
    if (newSourceLinks.length !== source.links.length) {
      source.links = newSourceLinks;
      source.updatedAt = ts;
      await this.repo.write(source);
    }
    if (newTargetLinks.length !== target.links.length) {
      target.links = newTargetLinks;
      target.updatedAt = ts;
      await this.repo.write(target);
    }
  }
}
