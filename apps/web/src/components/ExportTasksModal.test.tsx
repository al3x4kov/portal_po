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

// ─── Task 12 · F-2.2: tracker flow, navigation, download, generator branches ──

describe('Task 12 — tracker flow via RequirementPickerModal', () => {
  it('«Задачи в TaskTracker» opens the picker; confirming builds the tracker preview', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    expect(await screen.findByTestId('tracker-select-modal')).toBeInTheDocument();

    // All requirements are pre-selected → confirm right away («Предпросмотр»).
    await user.click(screen.getByTestId('export-next'));
    const preview = await screen.findByTestId('export-tasks-preview');
    expect(preview).toHaveTextContent('# Задачи для TaskTracker');
    expect(preview).toHaveTextContent('ФТ А');
    expect(preview).toHaveTextContent('ФТ Б');
  });

  it('deselected requirements are excluded from the tracker preview together with links to them', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await screen.findByTestId('tracker-select-modal');
    // Uncheck ftB.
    await user.click(screen.getByTestId('export-item-ft-b').querySelector('input')!);
    await user.click(screen.getByTestId('export-next'));

    const preview = await screen.findByTestId('export-tasks-preview');
    expect(preview).toHaveTextContent('ФТ А');
    expect(preview).not.toHaveTextContent('ФТ Б');
    expect(preview).not.toHaveTextContent('PARENT_OF: ft-b');
  });

  it('cancelling the picker returns to the direction choice', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await screen.findByTestId('tracker-select-modal');
    await user.click(screen.getByRole('button', { name: 'Отменить' }));

    expect(await screen.findByTestId('export-tasks-dir-tracker')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-select-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-tasks-preview')).not.toBeInTheDocument();
  });
});

describe('Task 12 — step navigation and MD download', () => {
  it('«Назад» from the preview returns to the direction choice and clears the preview (smoke: нет шага 2)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    await screen.findByTestId('export-tasks-preview');
    await user.click(screen.getByTestId('gen-back-2'));

    expect(screen.getByTestId('export-tasks-dir-smoke')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tasks-preview')).not.toBeInTheDocument();
  });

  it('«Назад» from the unimpl-question returns to the direction choice', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftC]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    await screen.findByTestId('unimpl-question');
    await user.click(screen.getByTestId('gen-back-1'));

    expect(screen.getByTestId('export-tasks-dir-crit-regression')).toBeInTheDocument();
    expect(screen.queryByTestId('unimpl-question')).not.toBeInTheDocument();
  });

  it('T4 (§2.15.1): «Назад» из preview возвращает на ПРЕДЫДУЩИЙ шаг — вопрос о нереализованных', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftC]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-crit-regression'));
    await screen.findByTestId('unimpl-question');
    await user.click(screen.getByTestId('unimpl-include-yes'));
    await screen.findByTestId('export-tasks-preview');

    await user.click(screen.getByTestId('gen-back-2'));
    // Back to step 2 (the coverage question), not to the direction choice.
    expect(await screen.findByTestId('unimpl-question')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tasks-preview')).not.toBeInTheDocument();
  });

  it('T4 (§2.15.1): «Назад» из tracker-preview снова открывает выбор требований', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    await user.click(screen.getByTestId('export-tasks-dir-tracker'));
    await screen.findByTestId('tracker-select-modal');
    await user.click(screen.getByTestId('export-next'));
    await screen.findByTestId('export-tasks-preview');

    await user.click(screen.getByTestId('gen-back-2'));
    expect(await screen.findByTestId('tracker-select-modal')).toBeInTheDocument();
  });

  it('T4 (§2.15.1): индикатор шагов подсвечивает активный шаг и отмечает пройденные', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
    );

    // Шаг 1 активен на выборе направления.
    expect(screen.getByTestId('gen-steps')).toBeInTheDocument();
    expect(screen.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'todo');

    await user.click(screen.getByTestId('export-tasks-dir-smoke'));
    await screen.findByTestId('export-tasks-preview');
    expect(screen.getByTestId('gen-step-1')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('gen-step-2')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('gen-step-3')).toHaveAttribute('data-state', 'active');
  });

  it('«Скачать MD» builds a blob, clicks a temp anchor and revokes the URL', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    try {
      renderWithProviders(
        <ExportTasksModal projectId="proj-1" requirements={[ftA, ftB]} onClose={vi.fn()} />,
      );
      await user.click(screen.getByTestId('export-tasks-dir-smoke'));
      await screen.findByTestId('export-tasks-preview');

      await user.click(screen.getByTestId('export-tasks-download'));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    } finally {
      anchorClick.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('Task 12 — generator ordering branches', () => {
  it('generateSmoke orders equal criticality: roots before children, unimplemented before implemented', () => {
    const rootDone = makeReq({ slug: 'root-done', name: 'Корень готов', criticality: 'HIGH' });
    const rootPlanned = makeReq({
      slug: 'root-planned',
      name: 'Корень в плане',
      criticality: 'HIGH',
      implemented: false,
    });
    const childHigh = makeReq({
      slug: 'child-high',
      name: 'Дочка',
      criticality: 'HIGH',
      links: [{ type: 'CHILD_OF', targetSlug: 'root-done' }],
    });
    const md = generateSmoke([childHigh, rootDone, rootPlanned], new Map());

    const posPlanned = md.indexOf('req-slug: root-planned');
    const posDone = md.indexOf('req-slug: root-done');
    const posChild = md.indexOf('req-slug: child-high');
    // Same criticality: roots first; among roots — unimplemented first.
    expect(posPlanned).toBeLessThan(posDone);
    expect(posDone).toBeLessThan(posChild);
  });

  it('generateCritRegression orders equal criticality by child count, then unimplemented first', () => {
    const wide = makeReq({
      slug: 'wide',
      name: 'Широкий узел',
      criticality: 'CRITICAL',
      links: [
        { type: 'PARENT_OF', targetSlug: 'a' },
        { type: 'PARENT_OF', targetSlug: 'b' },
        { type: 'PARENT_OF', targetSlug: 'c' },
      ],
    });
    const narrowPlanned = makeReq({
      slug: 'narrow-planned',
      name: 'Узкий в плане',
      criticality: 'CRITICAL',
      implemented: false,
    });
    const narrowDone = makeReq({
      slug: 'narrow-done',
      name: 'Узкий готов',
      criticality: 'CRITICAL',
    });
    const md = generateCritRegression([narrowDone, narrowPlanned, wide], new Map());

    const posWide = md.indexOf('req-slug: wide');
    const posPlanned = md.indexOf('req-slug: narrow-planned');
    const posDone = md.indexOf('req-slug: narrow-done');
    expect(posWide).toBeLessThan(posPlanned);
    expect(posPlanned).toBeLessThan(posDone);
    // Wide node lists its children in covers-children.
    expect(md).toContain('covers-children:');
  });

  it('generateTracker emits targetQuarter/targetYear for planned requirements', () => {
    const planned = makeReq({
      slug: 'planned-q',
      name: 'Плановое',
      implemented: false,
      targetQuarter: 'Q4',
      targetYear: 2026,
    });
    const md = generateTracker([planned]);
    expect(md).toContain('targetQuarter: Q4');
    expect(md).toContain('targetYear: 2026');
  });

  it('generateFull links a child test case to its parent via parent-tc and lists RELATES_TO slugs', () => {
    const parent = makeReq({
      slug: 'p1',
      name: 'Платежи',
      links: [{ type: 'PARENT_OF', targetSlug: 'c1' }],
    });
    const child = makeReq({
      slug: 'c1',
      name: 'Оплата картой',
      links: [
        { type: 'CHILD_OF', targetSlug: 'p1' },
        { type: 'RELATES_TO', targetSlug: 'p1' },
      ],
    });
    const md = generateFull([parent, child], new Map());
    expect(md).toContain('parent-tc: FUL-001');
    expect(md).toContain('**Связанные требования:** p1');
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
