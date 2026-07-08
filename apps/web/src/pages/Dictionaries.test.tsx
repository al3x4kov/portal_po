import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Dictionaries } from './Dictionaries';
import { renderWithProviders } from '../test/utils';

const getDict = vi.fn();
const addPriority = vi.fn();
const updatePriority = vi.fn();
const deletePriority = vi.fn();
const addSource = vi.fn();
const deleteSource = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: vi.fn().mockResolvedValue({
      id: 'proj1',
      name: 'CRM',
      mainPath: '/Projects/proj1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  },
  dictionariesApi: {
    get: (...a: unknown[]) => getDict(...a),
    addPriority: (...a: unknown[]) => addPriority(...a),
    updatePriority: (...a: unknown[]) => updatePriority(...a),
    deletePriority: (...a: unknown[]) => deletePriority(...a),
    addSource: (...a: unknown[]) => addSource(...a),
    updateSource: vi.fn(),
    deleteSource: (...a: unknown[]) => deleteSource(...a),
  },
  aiApi: { getConfig: vi.fn().mockResolvedValue({ baseURL: '', hasApiKey: false }) },
}));

function renderDict() {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/dictionaries" element={<Dictionaries />} />
    </Routes>,
    { route: '/p/proj1/dictionaries' },
  );
}

describe('Dictionaries screen (T-202)', () => {
  beforeEach(() => {
    addPriority.mockReset();
    updatePriority.mockReset();
    deletePriority.mockReset();
    addSource.mockReset();
    deleteSource.mockReset();
    getDict.mockResolvedValue({
      priorities: [
        { id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 },
        { id: 'p2', name: 'Критично', color: 'red', order: 1 },
      ],
      sources: [{ id: 's1', name: 'Альфа', type: 'CLIENT' }],
    });
  });

  it('renders the priorities and sources with a «дефолт» badge', async () => {
    renderDict();
    expect(await screen.findByTestId('prio-row-default')).toBeInTheDocument();
    expect(screen.getByTestId('prio-default-default')).toHaveTextContent('дефолт');
    expect(screen.getByTestId('prio-row-p2')).toBeInTheDocument();
    expect(screen.getByTestId('source-name-s1')).toHaveValue('Альфа');
  });

  it('adds a priority with a name + palette colour', async () => {
    addPriority.mockResolvedValue({ id: 'p3', name: 'Демо', color: 'green', order: 2 });
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-default');
    await user.click(screen.getByTestId('prio-add-open'));
    await user.type(screen.getByTestId('prio-add-name'), 'Демо');
    await user.click(screen.getByTestId('prio-add-color-green'));
    await user.click(screen.getByTestId('prio-add-save'));
    await waitFor(() =>
      expect(addPriority).toHaveBeenCalledWith('proj1', { name: 'Демо', color: 'green' }),
    );
  });

  it('deleting a used priority requires choosing a replacement (reassignTo)', async () => {
    deletePriority.mockResolvedValue(null);
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-p2');
    await user.click(screen.getByTestId('prio-delete-p2'));
    // Confirm is disabled until a replacement is chosen.
    const confirm = screen.getByTestId('prio-delete-confirm-p2');
    expect(confirm).toBeDisabled();
    await user.selectOptions(screen.getByTestId('prio-reassign-p2'), 'default');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(deletePriority).toHaveBeenCalledWith('proj1', 'p2', 'default'));
  });

  it('adds a source with a type', async () => {
    addSource.mockResolvedValue({ id: 's2', name: 'Бета', type: 'STAKEHOLDER' });
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('source-row-s1');
    await user.click(screen.getByTestId('source-add-open'));
    await user.type(screen.getByTestId('source-add-name'), 'Бета');
    await user.selectOptions(screen.getByTestId('source-add-type'), 'STAKEHOLDER');
    await user.click(screen.getByTestId('source-add-save'));
    await waitFor(() =>
      expect(addSource).toHaveBeenCalledWith('proj1', { name: 'Бета', type: 'STAKEHOLDER' }),
    );
  });
});
