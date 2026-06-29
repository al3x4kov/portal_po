import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { OpenExisting } from './OpenExisting';
import { renderWithProviders } from '../test/utils';
import { sampleProjects } from '../test/fixtures';

const list = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    list: () => list(),
    create: vi.fn(),
    get: vi.fn(),
    import: vi.fn(),
    export: vi.fn(),
  },
  requirementsApi: {},
  linksApi: {},
}));

describe('OpenExisting (T-603, FR-4)', () => {
  it('renders the project list from GET /api/projects', async () => {
    list.mockResolvedValueOnce(sampleProjects);
    renderWithProviders(<OpenExisting />);

    expect(await screen.findByTestId('open-list')).toBeInTheDocument();
    expect(screen.getByTestId('open-project-payments-platform')).toHaveAttribute(
      'href',
      '/p/payments-platform',
    );
    expect(screen.getByText('imported-crm')).toBeInTheDocument();
  });

  it('shows an empty state when there are no projects', async () => {
    list.mockResolvedValueOnce([]);
    renderWithProviders(<OpenExisting />);
    expect(await screen.findByTestId('open-empty')).toBeInTheDocument();
  });
});
