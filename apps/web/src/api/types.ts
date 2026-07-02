import type { Criticality, LinkType, Requirement, RequirementType, TargetQuarter } from '@po/core';

/** Project descriptor returned by the API (mirrors server ProjectSummary). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Absolute filesystem path of the project directory (FR-5.1 "Main Path"). */
  mainPath: string;
  createdAt: string;
}

export interface BrokenRequirement {
  file: string;
  error: string;
}

/** GET /api/projects/:id/requirements response. */
export interface RequirementListResult {
  requirements: Requirement[];
  broken: BrokenRequirement[];
  /**
   * Slugs of requirements lacking a complete acceptance criterion (SA-4/SA-6):
   * no scenarios at all, or at least one scenario missing WHEN/THEN.
   */
  incomplete: string[];
}

/** GET /api/projects/:id/requirements/check-name response. */
export interface CheckNameResult {
  available: boolean;
  /** Slug a new requirement with this name would receive (deduped within its type). */
  slug: string;
}

/** Body for POST /api/projects/:id/requirements. */
export interface RequirementCreateInput {
  type: RequirementType;
  name: string;
  criticality: Criticality;
  description?: string;
  implemented: boolean;
  targetQuarter?: TargetQuarter;
  targetYear?: number;
}

/** Body for PUT /api/projects/:id/requirements/:rid (type is immutable). */
export type RequirementUpdateInput = Omit<RequirementCreateInput, 'type'>;

/** Body for POST/DELETE /api/projects/:id/links. */
export interface LinkInput {
  sourceSlug: string;
  type: LinkType;
  targetSlug: string;
}

/** Unified server error envelope: { code, message, details }. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
