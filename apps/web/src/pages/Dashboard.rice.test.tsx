import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const listRequirements = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: vi.fn().mockResolvedValue({
      id: 'proj-1',
      name: 'test',
      mainPath: '/Projects/test',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    export: vi.fn(),
    exportXlsx: vi.fn(),
    exportSelected: vi.fn(),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
  dictionariesApi: { get: vi.fn().mockResolvedValue({ priorities: [], sources: [] }) },
}));

function renderDashboard(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/dashboard" element={<Dashboard />} />
    </Routes>,
    { route: '/p/proj-1/dashboard' },
  );
}

describe('Dashboard top-5 by RICE (T-209)', () => {
  beforeEach(() => listRequirements.mockReset());

  it('ranks requirements by aggregate RICE and shows the score', async () => {
    const high = makeReq({
      slug: 'high',
      name: 'Высокий',
      sources: [
        {
          type: 'CLIENT',
          name: 'A',
          priorityId: 'default',
          rice: { reach: 5, impact: 3, confidence: 1, effort: 1 },
        },
      ],
    });
    const low = makeReq({
      slug: 'low',
      name: 'Низкий',
      sources: [
        {
          type: 'CLIENT',
          name: 'B',
          priorityId: 'default',
          rice: { reach: 1, impact: 1, confidence: 1, effort: 8 },
        },
      ],
    });
    const none = makeReq({ slug: 'none', name: 'Без оценки' });
    listRequirements.mockResolvedValue({
      requirements: [low, none, high],
      broken: [],
      incomplete: [],
    });
    renderDashboard();

    const card = await screen.findByTestId('dash-top-rice');
    // Both scored requirements listed; the unscored one is excluded.
    expect(screen.getByTestId('dash-top-rice-item-high')).toBeInTheDocument();
    expect(screen.getByTestId('dash-top-rice-item-low')).toBeInTheDocument();
    expect(screen.queryByTestId('dash-top-rice-item-none')).not.toBeInTheDocument();
    // Highest score first.
    const items = card.querySelectorAll('[data-testid^="dash-top-rice-item-"]');
    expect(items[0].getAttribute('data-testid')).toBe('dash-top-rice-item-high');
    expect(screen.getByTestId('dash-top-rice-score-high')).toHaveTextContent('15');
  });

  it('shows an empty state when no requirement has a RICE estimate', async () => {
    listRequirements.mockResolvedValue({
      requirements: [makeReq({ slug: 'x', name: 'X' })],
      broken: [],
      incomplete: [],
    });
    renderDashboard();
    expect(await screen.findByTestId('dash-top-rice-empty')).toBeInTheDocument();
  });
});
