import type { RequirementType } from './types.js';

/**
 * Single source of truth for the requirement-type → storage folder mapping
 * (`openspec/specs/{functions|nfr}`, ADR-001). Reused by the filesystem
 * repositories, the archive importer and the OpenSpec route (BE-8).
 */
export const REQUIREMENT_FOLDER: Record<RequirementType, string> = {
  FUNCTION: 'functions',
  NFR: 'nfr',
};

/** Resolve the storage folder name for a requirement type. */
export function folderForType(type: RequirementType): string {
  return REQUIREMENT_FOLDER[type];
}
