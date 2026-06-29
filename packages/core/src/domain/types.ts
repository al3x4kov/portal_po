export const REQUIREMENT_TYPES = ['FUNCTION', 'NFR'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
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

/** A typed, directed edge to another requirement (stored on both endpoints). */
export interface Link {
  type: LinkType;
  targetId: string;
}

/** A single functional (FUNCTION) or non-functional (NFR) requirement. */
export interface Requirement {
  /** ULID, immutable, unique within a project. */
  id: string;
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
  links: Link[];
  createdAt: string;
  updatedAt: string;
}
