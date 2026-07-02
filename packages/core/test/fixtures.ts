import type { Link, Requirement } from '../src/index.js';

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return String(counter).padStart(4, '0');
};

let clock = 0;
const stamp = (): string => {
  clock += 1;
  return `2026-01-01T00:00:${String(clock).padStart(2, '0')}Z`;
};

/** Build a valid Requirement with sensible defaults, overridable per field. */
export function makeReq(overrides: Partial<Requirement> = {}): Requirement {
  const ts = stamp();
  const id = nextId();
  return {
    slug: `req-${id}`,
    type: 'FUNCTION',
    name: `Requirement ${id}`,
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

export const link = (type: Link['type'], targetSlug: string): Link => ({ type, targetSlug });
