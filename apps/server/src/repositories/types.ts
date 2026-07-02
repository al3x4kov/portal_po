export { SCHEMA_VERSION, type ProjectManifest } from '@po/core';

/** Project descriptor returned by the API (id === sanitized directory name). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Absolute filesystem path of the project directory (FR-5.1 "Main Path"). */
  mainPath: string;
  createdAt: string;
}
