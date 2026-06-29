import type { Requirement } from '@po/core';
import type { ProjectSummary } from '../api/types';

export function makeReq(
  partial: Partial<Requirement> & { id: string; name: string },
): Requirement {
  return {
    type: 'FUNCTION',
    criticality: 'MEDIUM',
    implemented: true,
    description: '',
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

/** Parent → child pair wired with PARENT_OF / CHILD_OF inverse links. */
export function makeHierarchy(): { parent: Requirement; child: Requirement } {
  const parent = makeReq({
    id: 'p1',
    name: 'Платежи',
    criticality: 'CRITICAL',
    links: [{ type: 'PARENT_OF', targetId: 'c1' }],
  });
  const child = makeReq({
    id: 'c1',
    name: 'Оплата картой',
    criticality: 'HIGH',
    links: [{ type: 'CHILD_OF', targetId: 'p1' }],
  });
  return { parent, child };
}

export const sampleProjects: ProjectSummary[] = [
  { id: 'payments-platform', name: 'payments-platform', mainPath: '/Projects/payments-platform', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'imported-crm', name: 'imported-crm', mainPath: '/Projects/imported-crm', createdAt: '2026-01-02T00:00:00.000Z' },
];
