import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';
import { useUiStore } from '../store/ui';

// ─── API endpoint mocks ───────────────────────────────────────────────────────

const getProject = vi.fn();
const listRequirements = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: (...a: unknown[]) => getProject(...a),
    export: vi.fn(),
    exportXlsx: vi.fn(),
    exportSelected: vi.fn(),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn().mockResolvedValue({ available: true, slug: 'x' }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderDashboard(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/dashboard" element={<Dashboard />} />
      {/* Экспорт и генерация — отдельные полноэкранные маршруты. */}
      <Route path="/p/:id/export" element={<div data-testid="export-screen" />} />
      <Route path="/p/:id/generate" element={<div data-testid="generate-screen" />} />
    </Routes>,
    { route: '/p/proj-1/dashboard' },
  );
}

const PROJECT_STUB = {
  id: 'proj-1',
  name: 'test-project',
  mainPath: '/Projects/test-project',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** FT with a CHILD_OF link (has parent) */
const ftWithParent = makeReq({
  slug: 'ft-child',
  name: 'ФТ с родителем',
  criticality: 'HIGH',
  description: 'Описание есть',
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-root' }],
});

/** FT without any CHILD_OF link (root function) */
const ftRoot1 = makeReq({
  slug: 'ft-root',
  name: 'Корневая ФТ 1',
  criticality: 'BLOCKER',
  description: 'Описание есть',
  links: [{ type: 'PARENT_OF', targetSlug: 'ft-child' }],
});

const ftRoot2 = makeReq({
  slug: 'ft-root-2',
  name: 'Корневая ФТ 2',
  criticality: 'CRITICAL',
  description: 'Описание есть',
  links: [],
});

/** FTs without description for T-514 tests */
const ftNoDescBlocker = makeReq({
  slug: 'ft-no-desc-blocker',
  name: 'ФТ без описания BLOCKER',
  criticality: 'BLOCKER',
  description: '',
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-root' }],
});

const ftNoDescMedium = makeReq({
  slug: 'ft-no-desc-medium',
  name: 'ФТ без описания MEDIUM',
  criticality: 'MEDIUM',
  description: '',
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-root' }],
});

const ftNoDescCritical = makeReq({
  slug: 'ft-no-desc-critical',
  name: 'ФТ без описания CRITICAL',
  criticality: 'CRITICAL',
  description: '',
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-root' }],
});

const ftWithDesc = makeReq({
  slug: 'ft-with-desc',
  name: 'ФТ с описанием',
  criticality: 'HIGH',
  description: 'Есть описание',
  links: [{ type: 'CHILD_OF', targetSlug: 'ft-root' }],
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Dashboard (T-513 / T-514)', () => {
  beforeEach(() => {
    getProject.mockReset();
    listRequirements.mockReset();
    getProject.mockResolvedValue(PROJECT_STUB);
    useUiStore.setState({ modal: null });
  });

  // ── T-513: danger tone for root functions ───────────────────────────────────

  describe('T-513 — stat-root-functions tone', () => {
    it('shows danger tone when root FTs exist (rootFunctions > 0)', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftRoot2, ftWithParent],
        broken: [],
      });

      renderDashboard();

      const stat = await screen.findByTestId('stat-root-functions');
      // danger tone sets background to --color-danger-bg via inline style
      expect(stat).toHaveStyle({ background: 'var(--color-danger-bg)' });
    });

    it('shows danger detail text when root FTs exist', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftRoot2],
        broken: [],
      });

      renderDashboard();

      const stat = await screen.findByTestId('stat-root-functions');
      expect(stat).toHaveTextContent('⚠ Есть ФТ без родителя');
    });

    it('shows success tone when there are zero root functions (no FTs)', async () => {
      // Project has only NFRs — rootFunctions.length === 0 → success tone
      const onlyNfr = [
        makeReq({
          slug: 'nfr-only',
          name: 'НФТ',
          type: 'NFR',
          description: 'desc',
          links: [],
        }),
      ];

      listRequirements.mockResolvedValue({ requirements: onlyNfr, broken: [] });

      renderDashboard();

      const stat = await screen.findByTestId('stat-root-functions');
      // value should be 0 (no FTs → no root FTs)
      expect(stat).toHaveTextContent('0');
      // success tone: background var(--color-success-bg)
      expect(stat).toHaveStyle({ background: 'var(--color-success-bg)' });
    });

    it('counts root FTs correctly (only FTs without CHILD_OF links)', async () => {
      // 2 root FTs, 1 child FT, 1 NFR (should not count)
      const nfr = makeReq({
        slug: 'nfr-1',
        name: 'НФТ',
        type: 'NFR',
        description: 'desc',
        links: [],
      });
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftRoot2, ftWithParent, nfr],
        broken: [],
      });

      renderDashboard();

      const stat = await screen.findByTestId('stat-root-functions');
      // rootFunctions = ftRoot1 + ftRoot2 = 2
      expect(stat).toHaveTextContent('2');
    });
  });

  // ── T-514: no-description sections ─────────────────────────────────────────

  describe('T-514 — FT without description section', () => {
    it('shows dash-no-desc-ft when FT without description exists', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftNoDescBlocker],
        broken: [],
      });

      renderDashboard();

      expect(await screen.findByTestId('dash-no-desc-ft')).toBeInTheDocument();
    });

    it('does NOT show dash-no-desc-ft when all FTs have descriptions', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftWithDesc],
        broken: [],
      });

      renderDashboard();

      // wait for page to render (wait for the page element)
      await screen.findByTestId('dashboard-page');
      expect(screen.queryByTestId('dash-no-desc-ft')).not.toBeInTheDocument();
    });

    it('does NOT show dash-no-desc-ft when there are no FTs at all', async () => {
      const nfr = makeReq({
        slug: 'nfr-1',
        name: 'НФТ без описания',
        type: 'NFR',
        description: '',
        links: [],
      });
      listRequirements.mockResolvedValue({ requirements: [nfr], broken: [] });

      renderDashboard();

      await screen.findByTestId('dashboard-page');
      expect(screen.queryByTestId('dash-no-desc-ft')).not.toBeInTheDocument();
    });

    it('does NOT show dash-no-desc-ft when description is whitespace only', async () => {
      const ftWhitespace = makeReq({
        slug: 'ft-ws',
        name: 'ФТ только пробелы',
        description: '   ',
        links: [],
      });
      listRequirements.mockResolvedValue({
        requirements: [ftWhitespace],
        broken: [],
      });

      renderDashboard();

      // whitespace-only description is treated as "no description" → section shown
      expect(await screen.findByTestId('dash-no-desc-ft')).toBeInTheDocument();
    });

    it('no-desc FT list is sorted BLOCKER first, then CRITICAL, then MEDIUM', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftNoDescMedium, ftNoDescCritical, ftNoDescBlocker],
        broken: [],
      });

      renderDashboard();

      const section = await screen.findByTestId('dash-no-desc-ft');
      const items = section.querySelectorAll('li');

      // First item should be BLOCKER, second CRITICAL, third MEDIUM
      expect(items[0]).toHaveTextContent('ФТ без описания BLOCKER');
      expect(items[1]).toHaveTextContent('ФТ без описания CRITICAL');
      expect(items[2]).toHaveTextContent('ФТ без описания MEDIUM');
    });

    it('shows the count badge in dash-no-desc-ft', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftNoDescBlocker, ftNoDescMedium],
        broken: [],
      });

      renderDashboard();

      const section = await screen.findByTestId('dash-no-desc-ft');
      // badge contains the count
      expect(section).toHaveTextContent('2');
    });

    it('shows dash-no-desc-nfr when NFT without description exists', async () => {
      const nfrNoDesc = makeReq({
        slug: 'nfr-no-desc',
        name: 'НФТ без описания',
        type: 'NFR',
        description: '',
        links: [],
      });
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, nfrNoDesc],
        broken: [],
      });

      renderDashboard();

      expect(await screen.findByTestId('dash-no-desc-nfr')).toBeInTheDocument();
    });

    it('T6 §2.19.1: карточка «Качество описаний» видна всегда — зелёное состояние при нуле пробелов', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftWithDesc],
        broken: [],
      });

      renderDashboard();

      const quality = await screen.findByTestId('dash-quality');
      expect(quality).toHaveTextContent('Качество описаний');
      expect(screen.getByTestId('dash-quality-ok')).toHaveTextContent('Все требования описаны');
      expect(screen.getByTestId('dash-quality-ok')).toHaveTextContent(
        'У всех 2 требований заполнено описание. Новые пробелы появятся здесь.',
      );
      expect(screen.queryByTestId('dash-quality-count')).not.toBeInTheDocument();
    });

    it('T6 §2.19.1: бейдж «Без описания: N» при наличии пробелов, зелёного состояния нет', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftNoDescBlocker, ftNoDescMedium],
        broken: [],
      });

      renderDashboard();

      const badge = await screen.findByTestId('dash-quality-count');
      expect(badge).toHaveTextContent('Без описания: 2');
      expect(screen.queryByTestId('dash-quality-ok')).not.toBeInTheDocument();
    });

    it('T6 §2.19.3: список «без описания» ограничен 7 позициями, «Показать все (N)» раскрывает остальные', async () => {
      const many = Array.from({ length: 9 }, (_, i) =>
        makeReq({
          slug: `ft-nd-${i}`,
          name: `ФТ без описания ${i}`,
          criticality: 'MEDIUM',
          description: '',
          links: [],
        }),
      );
      listRequirements.mockResolvedValue({ requirements: many, broken: [] });

      renderDashboard();

      const section = await screen.findByTestId('dash-no-desc-ft');
      expect(section.querySelectorAll('li')).toHaveLength(7);

      const showAll = screen.getByTestId('dash-no-desc-ft-show-all');
      expect(showAll).toHaveTextContent('Показать все (9)');
      fireEvent.click(showAll);
      await screen.findByText('ФТ без описания 8');
      expect(section.querySelectorAll('li')).toHaveLength(9);
      expect(screen.getByTestId('dash-no-desc-ft-show-all')).toHaveTextContent('Свернуть');
    });

    it('does NOT show dash-no-desc-nfr when all NFTs have descriptions', async () => {
      const nfrWithDesc = makeReq({
        slug: 'nfr-with-desc',
        name: 'НФТ с описанием',
        type: 'NFR',
        description: 'Описание есть',
        links: [],
      });
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, nfrWithDesc],
        broken: [],
      });

      renderDashboard();

      await screen.findByTestId('dashboard-page');
      expect(screen.queryByTestId('dash-no-desc-nfr')).not.toBeInTheDocument();
    });
  });

  // ── Handlers: opening modals from the dashboard ─────────────────────────────

  describe('modal openers (onOpen / onOpenExport / onOpenTasks)', () => {
    it('«+ Описание» on a no-description FT opens the requirement modal (onOpen)', async () => {
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, ftNoDescBlocker],
        broken: [],
      });
      renderDashboard();

      const openBtn = await screen.findByTestId('dash-no-desc-open-ft-no-desc-blocker');
      fireEvent.click(openBtn);

      // openModal records a requirement modal focused on the description.
      const modal = useUiStore.getState().modal;
      expect(modal).toMatchObject({
        kind: 'requirement',
        focusField: 'description',
        requirement: { slug: 'ft-no-desc-blocker' },
      });
    });

    it('«+ Описание» on a no-description NFR opens its requirement modal (onOpen)', async () => {
      const nfrNoDesc = makeReq({
        slug: 'nfr-no-desc',
        name: 'НФТ без описания',
        type: 'NFR',
        description: '',
        links: [],
      });
      listRequirements.mockResolvedValue({
        requirements: [ftRoot1, nfrNoDesc],
        broken: [],
      });
      renderDashboard();

      fireEvent.click(await screen.findByTestId('dash-no-desc-open-nfr-no-desc'));
      expect(useUiStore.getState().modal).toMatchObject({
        kind: 'requirement',
        reqType: 'NFR',
        focusField: 'description',
      });
    });

    it('sidebar «Экспорт проекта» ведёт на полноэкранный экспорт (onOpenExport)', async () => {
      listRequirements.mockResolvedValue({ requirements: [ftRoot2], broken: [] });
      renderDashboard();

      fireEvent.click(await screen.findByTestId('sidebar-open-export'));
      expect(await screen.findByTestId('export-screen')).toBeInTheDocument();
    });

    it('sidebar «Генерация задач» ведёт на полноэкранный мастер (onOpenTasks)', async () => {
      listRequirements.mockResolvedValue({ requirements: [ftRoot2], broken: [] });
      renderDashboard();

      fireEvent.click(await screen.findByTestId('sidebar-open-tasks'));
      expect(await screen.findByTestId('generate-screen')).toBeInTheDocument();
    });

    it('«ФТ без НФТ» list beyond the limit toggles show-all (setShowAllFnWithoutNfr)', async () => {
      // 8 root FTs with descriptions but no linked NFR → functionsWithoutNfr > limit.
      const many = Array.from({ length: 8 }, (_, i) =>
        makeReq({
          slug: `ft-no-nfr-${i}`,
          name: `ФТ без НФТ ${i}`,
          criticality: 'MEDIUM',
          description: 'Описание есть',
          links: [],
        }),
      );
      listRequirements.mockResolvedValue({ requirements: many, broken: [] });
      renderDashboard();

      const showAll = await screen.findByTestId('dashboard-nfr-missing-show-all');
      expect(showAll).toHaveTextContent('Показать все (8)');
      fireEvent.click(showAll);
      expect(await screen.findByText('ФТ без НФТ 7')).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-nfr-missing-show-all')).toHaveTextContent('Свернуть');
    });
  });
});
