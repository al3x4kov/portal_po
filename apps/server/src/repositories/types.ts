/** On-disk manifest stored as `project.json` in each project directory. */
export interface ProjectManifest {
  name: string;
  schemaVersion: number;
  createdAt: string;
}

/** Project descriptor returned by the API (id === sanitized directory name). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Absolute filesystem path of the project directory (FR-5.1 "Main Path"). */
  mainPath: string;
  createdAt: string;
}

/** Current manifest schema version. */
export const SCHEMA_VERSION = 1;
