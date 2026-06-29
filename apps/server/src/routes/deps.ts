/** Dependencies injected into every route plugin. */
export interface AppDeps {
  projectsRoot: string;
  /** Clock injection point for deterministic timestamps in tests. */
  now: () => string;
}
