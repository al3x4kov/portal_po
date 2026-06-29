import type { Requirement, RequirementType } from '../domain/types.js';
import { UniquenessError } from '../domain/errors.js';

export interface NameCandidate {
  /** Own id; when set, the matching existing requirement is excluded (self-rename). */
  id?: string;
  type: RequirementType;
  name: string;
}

const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * Assert that `candidate.name` is unique within its `type` (case-insensitive, trimmed).
 * Renaming a requirement to its own current name is allowed (own id is excluded).
 *
 * @throws {UniquenessError} when a conflicting requirement exists.
 */
export function assertUniqueName(reqs: readonly Requirement[], candidate: NameCandidate): void {
  const target = normalizeName(candidate.name);
  const conflict = reqs.find(
    (r) => r.type === candidate.type && r.id !== candidate.id && normalizeName(r.name) === target,
  );
  if (conflict) {
    throw new UniquenessError(
      `A ${candidate.type} requirement named "${candidate.name.trim()}" already exists (id=${conflict.id}).`,
    );
  }
}
