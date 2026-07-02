import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Requirement } from '@po/core';
import {
  ExportTasksModal,
  generateTracker,
  generateSmoke,
  generateCritRegression,
  generateFull,
} from './ExportTasksModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeNameMap(reqs: Requirement[]): Map<string, string> {
  return new Map(reqs.map((r) => [r.slug, r.name]));
}

const ftA = makeReq({
  slug: 'ft-a',
  name: 'ФТ А',
  criticality: 'BLOCKER',
  description: 'Описание А',
  implemented: true,
  links: [
    { type: 'PARENT_OF', targetSlug: 'ft-b' },
    { type: 'PARENT_OF', targetSlug: 'ft-c' },
    { type: 'RELATES_TO', targetSlug: 'ft-outside' }, // not in export set
  ],
});

const ftB = makeReq({
  slug: 'ft-b',
  name: 'ФТ Б',
  criticality: 'HIGH',
  description: 'Описание Б',
  implemented: true,
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-a' }],
});

const ftC = makeReq({
  slug: 'ft-c',
  name: 'ФТ В',
  criticality: 'MEDIUM',
  description: 'Описание В',
  implemented: false,
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-a' }],
});

const nfrA = makeReq({
  slug: 'nfr-a',
  name: 'НФТ А',
  type: 'NFR',
  criticality: 'HIGH',
  description: 'НФТ описание',
  implemented: true,
  links: [],
});

/** FT that has a BLOCKED_BY link to an NFR */
const ftWithNfrLink = makeReq({
  slug: 'ft-with-nfr',
  name: 'ФТ с НФТ',
  criticality: 'CRITICAL',
  description: 'Есть описание',
  implemented: true,
  links: [{ type: 'BLOCKED_BY', targetSlug: 'nfr-a' }],
});

// ─── T-528: generateTracker link filtering ────────────────────────────────────

describe('T-528 — generateTracker link filtering', () => {
  it('includes links whose targetSlug is in the export set', () => {
    const reqs = [ftA, ftB, ftC];
    const exportSet = new Set(['ft-a', 'ft-b', 'ft-c']);
    const md = generateTracker(reqs, exportSet);

    // ft-a has PARENT_OF ft-b and ft-c — both in export set
    expect(md).toContain('PARENT_OF: ft-b');
    expect(md).toContain('PARENT_OF: ft-c');
  });

  it('excludes links whose targetSlug is NOT in the export set', () => {
    const reqs = [ftA, ftB]; // ftC excluded from export
    const exportSet = new Set(['ft-a', 'ft-b']);
    const md = generateTracker(reqs, exportSet);

    // ft-a has PARENT_OF ft-c but ft-c is not in export set
    expect(md).not.toContain('PARENT_OF: ft-c');
    // ft-a has RELATES_TO ft-outside — also not in export
    expect(md).not.toContain('RELATES_TO: ft-outside');
    // but PARENT_OF ft-b should still be there
    expect(md).toContain('PARENT_OF: ft-b');
  });

  it('tracker MD excludes links to requirements not in export set', () => {
    // ft-a has 3 links: PARENT_OF ft-b, PARENT_OF ft-c, RELATES_TO ft-outside
    // Export set includes only ft-a and ft-b (2 of 3)
    const reqs = [ftA, ftB];
    const exportSet = new Set(['ft-a', 'ft-b']);
    const md = generateTracker(reqs, exportSet);

    // Only ft-b link should appear
    const ftASection = md.slice(md.indexOf('## ФТ А'));
    expect(ftASection).toContain('PARENT_OF: ft-b');
    expect(ftASection).not.toContain('ft-c');
    expect(ftASection).not.toContain('ft-outside');
  });

  it('NFR inclusion: tracker MD includes NFR links when NFR is in includedSlugs', () => {
    const reqs = [ftWithNfrLink, nfrA];
    const exportSet = new Set(['ft-with-nfr', 'nfr-a']);
    const md = generateTracker(reqs, exportSet);

    // BLOCKED_BY nfr-a should appear since nfr-a is in export
    expect(md).toContain('BLOCKED_BY: nfr-a');
  });

  it('NFR exclusion: tracker MD excludes NFR links when NFR not in includedSlugs', () => {
    const reqs = [ftWithNfrLink]; // nfr-a not in export
    const exportSet = new Set(['ft-with-nfr']);
    const md = generateTracker(reqs, exportSet);

    // BLOCKED_BY nfr-a should NOT appear since nfr-a is not in export set
    expect(md).not.toContain('BLOCKED_BY: nfr-a');
  });

  it('when no includedSlugs provided, uses all reqs slugs as default', () => {
    const reqs = [ftA, ftB, ftC];
    const md = generateTracker(reqs);

    // All links among reqs should be present
    // ft-a has PARENT_OF ft-b and ft-c (both in reqs)
    expect(md).toContain('PARENT_OF: ft-b');
    expect(md).toContain('PARENT_OF: ft-c');
    // RELATES_TO ft-outside is NOT in reqs → excluded
    expect(md).not.toContain('RELATES_TO: ft-outside');
  });
});

// ─── T-532: attribution line removal ─────────────────────────────────────────

describe('T-532 — generator attribution', () => {
  const allReqs = [ftA, ftB, ftC];
  const nameMap = makeNameMap(allReqs);

  it('generateSmoke header line starts with # Smoke-модель', () => {
    const md = generateSmoke(allReqs, nameMap);
    expect(md).toContain('# Smoke-модель тестирования');
  });

  it('generateCritRegression header contains # Критический', () => {
    const md = generateCritRegression(allReqs, nameMap);
    expect(md).toContain('# Критический регресс-модель');
  });

  it('generateFull header contains # Полная модель', () => {
    const md = generateFull(allReqs, nameMap);
    expect(md).toContain('# Полная модель тестирования');
  });
});

// ─── T-532: ExportTasksModal unimpl-question step ────────────────────────────

describe('T-532 — ExportTasksModal unimpl-question step', () => {
  const onClose = vi.fn();

  it('shows unimpl-question when crit-regression clicked and unimplemented FT exist', async () => {
    const user = userEvent.setup();
    const reqsWithUnimpl = [
      ftA, // implemented: true
      ftC, // implemented: false
    ];

    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={reqsWithUnimpl} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    expect(await screen.findByTestId('unimpl-question')).toBeInTheDocument();
    // preview should NOT be shown yet
    expect(screen.queryByTestId('export-tasks-preview')).not.toBeInTheDocument();
  });

  it('does NOT show unimpl-question when all FTs are implemented', async () => {
    const user = userEvent.setup();
    const allImplemented = [
      ftA, // implemented: true
      ftB, // implemented: true
    ];

    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={allImplemented} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    // Should go straight to preview
    expect(await screen.findByTestId('export-tasks-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('unimpl-question')).not.toBeInTheDocument();
  });

  it('clicking "Да" on unimpl-question shows preview with unimplemented FTs included', async () => {
    const user = userEvent.setup();
    const reqsWithUnimpl = [ftA, ftC];

    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={reqsWithUnimpl} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    await screen.findByTestId('unimpl-question');
    await user.click(screen.getByTestId('unimpl-include-yes'));

    const preview = await screen.findByTestId('export-tasks-preview');
    expect(preview).toBeInTheDocument();
    // ftC (не реализованная) should appear in preview
    expect(preview).toHaveTextContent('ФТ В');
  });

  it('clicking "Нет" on unimpl-question shows preview without unimplemented FTs', async () => {
    const user = userEvent.setup();
    const reqsWithUnimpl = [ftA, ftC]; // ftC is unimplemented

    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={reqsWithUnimpl} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    await screen.findByTestId('unimpl-question');
    await user.click(screen.getByTestId('unimpl-include-no'));

    const preview = await screen.findByTestId('export-tasks-preview');
    expect(preview).toBeInTheDocument();
    // ftC (unimplemented) should NOT appear
    expect(preview).not.toHaveTextContent('ФТ В');
  });

  it('does NOT show unimpl-question when no FTs exist (only NFTs)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[nfrA]} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    // Goes straight to preview
    expect(await screen.findByTestId('export-tasks-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('unimpl-question')).not.toBeInTheDocument();
  });
});

// ─── Smoke test: component renders without errors ─────────────────────────────

describe('ExportTasksModal — smoke', () => {
  it('renders the choice step with all direction buttons', () => {
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    expect(screen.getByTestId('export-tasks-dir-tracker')).toBeInTheDocument();
    expect(screen.getByTestId('export-tasks-dir-smoke')).toBeInTheDocument();
    expect(screen.getByTestId('export-tasks-dir-crit-regression')).toBeInTheDocument();
    expect(screen.getByTestId('export-tasks-dir-full')).toBeInTheDocument();
  });

  it('clicking smoke generates preview immediately', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    expect(await screen.findByTestId('export-tasks-preview')).toBeInTheDocument();
  });

  it('clicking full generates preview immediately', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-full'));
    expect(await screen.findByTestId('export-tasks-preview')).toBeInTheDocument();
  });
});
