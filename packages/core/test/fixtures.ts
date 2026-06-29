import { newId } from '../src/index.js';
import type { Link, Requirement } from '../src/index.js';

let clock = 0;
const stamp = (): string => {
  clock += 1;
  return `2026-01-01T00:00:${String(clock).padStart(2, '0')}Z`;
};

/** Build a valid Requirement with sensible defaults, overridable per field. */
export function makeReq(overrides: Partial<Requirement> = {}): Requirement {
  const ts = stamp();
  return {
    id: newId(),
    type: 'FUNCTION',
    name: `Requirement ${newId().slice(-6)}`,
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

export const link = (type: Link['type'], targetId: string): Link => ({ type, targetId });
