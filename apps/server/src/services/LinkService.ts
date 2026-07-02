import {
  assertNoCycle,
  assertNoSelfLink,
  assertSameType,
  assertSingleParent,
  createLinkPair,
  inverseLinkType,
  isHierarchyType,
  sameLink,
  type Link,
  type LinkType,
  type Requirement,
} from '@po/core';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';

export interface LinkInput {
  sourceSlug: string;
  type: LinkType;
  targetSlug: string;
}

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

  private find(reqs: Requirement[], slug: string, role: string): Requirement {
    const req = reqs.find((r) => r.slug === slug);
    if (!req) throw new NotFoundError(`${role} requirement not found: "${slug}".`);
    return req;
  }

  /** Create a link and its inverse, after enforcing all integrity rules. */
  async create({ sourceSlug, type, targetSlug }: LinkInput): Promise<void> {
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

    await this.repo.write(source);
    await this.repo.write(target);
  }

  /** Remove a link and its inverse from both endpoints (FR-8). */
  async remove({ sourceSlug, type, targetSlug }: LinkInput): Promise<void> {
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
