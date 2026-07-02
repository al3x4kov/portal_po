export const REQUIREMENT_TYPES = ['FUNCTION', 'NFR'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BLOCKER'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const LINK_TYPES = [
  'PARENT_OF',
  'CHILD_OF',
  'RELATES_TO',
  'DEPENDS_ON',
  'BLOCKED_BY',
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const TARGET_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
export type TargetQuarter = (typeof TARGET_QUARTERS)[number];

export const SCENARIO_KEYWORDS = ['GIVEN', 'WHEN', 'THEN', 'AND'] as const;
export type ScenarioKeyword = (typeof SCENARIO_KEYWORDS)[number];

/** A typed, directed edge to another requirement (stored on both endpoints). */
export interface Link {
  type: LinkType;
  /** Stable, human-readable slug of the target requirement (OpenSpec, ADR-001). */
  targetSlug: string;
}

/** A single GIVEN/WHEN/THEN/AND step of an OpenSpec scenario. */
export interface ScenarioStep {
  keyword: ScenarioKeyword;
  text: string;
}

/** An optional OpenSpec `#### Scenario:` block attached to a requirement. */
export interface Scenario {
  name: string;
  steps: ScenarioStep[];
}

/** A single functional (FUNCTION) or non-functional (NFR) requirement. */
export interface Requirement {
  /**
   * Stable, human-readable identifier (kebab, `[a-z0-9-]`), unique within
   * (project × type). Serves as the file name and as the target of links.
   * Immutable once created — renaming `name` does not change the slug (ADR-001).
   */
  slug: string;
  type: RequirementType;
  /** Unique within (project × type), case-insensitive + trimmed. 1..200 chars. */
  name: string;
  criticality: Criticality;
  /** Markdown body. Up to 5000 chars. */
  description?: string;
  implemented: boolean;
  /** Required iff implemented === false. */
  targetQuarter?: TargetQuarter;
  /** Required iff implemented === false. Range 2020..2100. */
  targetYear?: number;
  /** Optional OpenSpec scenarios (present only when non-empty). */
  scenarios?: Scenario[];
  links: Link[];
  createdAt: string;
  updatedAt: string;
}
