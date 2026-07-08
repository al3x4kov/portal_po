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
const updateSource = vi.fn();
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
    updateSource: (...a: unknown[]) => updateSource(...a),
    deleteSource: (...a: unknown[]) => deleteSource(...a),
  },
  aiApi: { getConfig: vi.fn().mockResolvedValue({ baseURL: '', hasApiKey: false }) },
}));

function renderDict(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/dictionaries" element={<Dictionaries />} />
    </Routes>,
    { route: '/p/proj1/dictionaries' },
  );
}

describe('Dictionaries CRUD handlers (T-202)', () => {
  beforeEach(() => {
    addPriority.mockReset();
    updatePriority.mockReset();
    deletePriority.mockReset();
    addSource.mockReset();
    updateSource.mockReset();
    deleteSource.mockReset();
    updatePriority.mockResolvedValue(null);
    updateSource.mockResolvedValue(null);
    getDict.mockResolvedValue({
      priorities: [
        { id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 },
        { id: 'p2', name: 'Критично', color: 'red', order: 1 },
      ],
      sources: [{ id: 's1', name: 'Альфа', type: 'CLIENT' }],
    });
  });

  it('renames a priority on blur (skips no-op / empty names)', async () => {
    const user = userEvent.setup();
    renderDict();
    const input = await screen.findByTestId('prio-name-p2');
    // No-op: same name → no mutation.
    input.focus();
    await user.tab();
    expect(updatePriority).not.toHaveBeenCalled();
    // Real rename.
    await user.clear(input);
    await user.type(input, 'Важное');
    await user.tab();
    await waitFor(() =>
      expect(updatePriority).toHaveBeenCalledWith('proj1', 'p2', { name: 'Важное' }),
    );
  });

  it('recolours a priority through the palette picker', async () => {
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-p2');
    await user.click(screen.getByTestId('prio-color-p2-green'));
    await waitFor(() =>
      expect(updatePriority).toHaveBeenCalledWith('proj1', 'p2', { color: 'green' }),
    );
  });

  it('reorders priorities via up/down (swaps orders, respects edges)', async () => {
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-default');
    // Top row cannot move up; last row cannot move down.
    expect(screen.getByTestId('prio-up-default')).toBeDisabled();
    expect(screen.getByTestId('prio-down-p2')).toBeDisabled();
    // Move «default» down → both rows get their orders swapped.
    await user.click(screen.getByTestId('prio-down-default'));
    await waitFor(() => {
      expect(updatePriority).toHaveBeenCalledWith('proj1', 'default', { order: 1 });
      expect(updatePriority).toHaveBeenCalledWith('proj1', 'p2', { order: 0 });
    });
  });

  it('surfaces a server error when adding a duplicate priority', async () => {
    addPriority.mockRejectedValue(new Error('Приоритет с таким именем уже есть'));
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-default');
    await user.click(screen.getByTestId('prio-add-open'));
    await user.type(screen.getByTestId('prio-add-name'), 'Критично');
    await user.click(screen.getByTestId('prio-add-save'));
    expect(await screen.findByTestId('prio-error')).toHaveTextContent(/уже есть/);
  });

  it('cancels the delete panel without deleting', async () => {
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('prio-row-p2');
    await user.click(screen.getByTestId('prio-delete-p2'));
    expect(screen.getByTestId('prio-delete-panel-p2')).toBeInTheDocument();
    await user.click(screen.getByTestId('prio-delete-cancel-p2'));
    await waitFor(() => expect(screen.queryByTestId('prio-delete-panel-p2')).toBeNull());
    expect(deletePriority).not.toHaveBeenCalled();
  });

  it('renames a source on blur', async () => {
    const user = userEvent.setup();
    renderDict();
    const input = await screen.findByTestId('source-name-s1');
    await user.clear(input);
    await user.type(input, 'Альфа-банк');
    await user.tab();
    await waitFor(() =>
      expect(updateSource).toHaveBeenCalledWith('proj1', 's1', { name: 'Альфа-банк' }),
    );
  });

  it('changes a source type', async () => {
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('source-row-s1');
    await user.selectOptions(screen.getByTestId('source-type-s1'), 'STAKEHOLDER');
    await waitFor(() =>
      expect(updateSource).toHaveBeenCalledWith('proj1', 's1', { type: 'STAKEHOLDER' }),
    );
  });

  it('deletes a source and shows a server error on failure', async () => {
    deleteSource.mockRejectedValue(new Error('Источник используется требованиями'));
    const user = userEvent.setup();
    renderDict();
    await screen.findByTestId('source-row-s1');
    await user.click(screen.getByTestId('source-delete-s1'));
    await waitFor(() => expect(deleteSource).toHaveBeenCalledWith('proj1', 's1'));
    expect(await screen.findByTestId('source-error')).toHaveTextContent(/используется/);
  });

  it('shows the empty-source hint when the dictionary has no sources', async () => {
    getDict.mockResolvedValue({
      priorities: [{ id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 }],
      sources: [],
    });
    renderDict();
    expect(await screen.findByTestId('source-empty')).toBeInTheDocument();
  });
});
