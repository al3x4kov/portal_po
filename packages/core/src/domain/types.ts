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

/** One element of supplementary reference information attached to a requirement. */
export interface InfoItem {
  /** Type/key label, up to 50 characters. */
  type: string;
  /** Value, up to 100 characters. */
  value: string;
}

/** Preset values for the requirement source field. */
export const SOURCE_PRESETS = ['АС21', 'ПАО'] as const;
export type ScenarioKeyword = (typeof SCENARIO_KEYWORDS)[number];

// ---------------------------------------------------------------------------
// todo_19 — multiple requirement sources, RICE scoring and project dictionaries
// ---------------------------------------------------------------------------

/**
 * Kind of a requirement source (todo_19 §0.1). todo_22 adds `BACKLOG` —
 * a requirement imported from a backlog file (PO decision №4); reading old
 * `.md` files without it stays valid (enum only widens).
 */
export const SOURCE_TYPES = ['CLIENT', 'STAKEHOLDER', 'STANDARD', 'TEXT', 'BACKLOG'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Base RICE selector scales (fixed by PO). */
export const RICE_REACH = [1, 2, 3, 4, 5] as const;
export const RICE_IMPACT = [0.25, 0.5, 1, 2, 3] as const;
export const RICE_CONFIDENCE = [0.5, 0.8, 1] as const;
export const RICE_EFFORT = [0.5, 1, 2, 3, 5, 8] as const;

/** A single RICE estimate attached to one source. */
export interface Rice {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}

/** Fixed priority-color palette (keys map to project design tokens). */
export const PRIORITY_COLORS = [
  'red',
  'amber',
  'blue',
  'green',
  'purple',
  'sky',
  'gray',
  'pink',
] as const;
export type PriorityColor = (typeof PRIORITY_COLORS)[number];

/**
 * One source attached to a requirement (0..N per requirement). `name` references
 * the project source dictionary by name; `priorityId` references the project
 * priority dictionary by id.
 */
export interface SourceEntry {
  type: SourceType;
  /** 1..100, trimmed. */
  name: string;
  /** Id of an entry in the project priority dictionary (never empty). */
  priorityId: string;
  /** Optional RICE estimate (see scoring/). */
  rice?: Rice;
  targetQuarter?: TargetQuarter;
  /** Range 2020..2100. */
  targetYear?: number;
  /** ISO `yyyy-mm-dd`, optional. */
  targetDate?: string;
}

/** A project source-priority dictionary entry. `order` = seniority (0 = highest). */
export interface SourcePriority {
  id: string;
  /** 1..40, trimmed, unique (case-insensitive) within the project. */
  name: string;
  color: PriorityColor;
  order: number;
}

/** A project source dictionary entry (collected manually and via auto-collect). */
export interface SourceRef {
  id: string;
  /** 1..100, trimmed, unique (case-insensitive) within the project. */
  name: string;
  type: SourceType;
  /** Optional display color token. */
  color?: string;
}

/** The two per-project dictionaries persisted in `dictionaries.json`. */
export interface ProjectDictionaries {
  priorities: SourcePriority[];
  sources: SourceRef[];
}

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
  /** Requirement source (free string; presets: SOURCE_PRESETS). Undefined = "not set". */
  source?: string;
  /** Supplementary reference information as key-value pairs. */
  infoItems?: InfoItem[];
  /** Multiple requirement sources (todo_19). Present only when non-empty. */
  sources?: SourceEntry[];
  /** PO release date, ISO `yyyy-mm-dd`. Cleared when implemented === true. */
  releaseDate?: string;
}
