import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementModal } from './RequirementModal';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';

const checkName = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock('../api/endpoints', () => ({
  requirementsApi: {
    checkName: (...a: unknown[]) => checkName(...a),
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    list: vi.fn(),
    remove: vi.fn(),
  },
  projectsApi: {},
  linksApi: {},
}));

describe('RequirementModal (T-605, FR-6)', () => {
  beforeEach(() => {
    checkName.mockReset();
    create.mockReset();
    update.mockReset();
    checkName.mockResolvedValue({ available: true });
  });

  it('shows quarter/year only while "не реализовано" is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />);

    // default = not implemented → conditional block present
    expect(screen.getByTestId('req-target-fields')).toBeInTheDocument();

    await user.click(screen.getByTestId('req-implemented-yes'));
    expect(screen.queryByTestId('req-target-fields')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('req-implemented-no'));
    expect(screen.getByTestId('req-target-fields')).toBeInTheDocument();
  });

  it('blocks "Применить" when the name is a duplicate (FR-6.6)', async () => {
    checkName.mockResolvedValue({ available: false });
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />);

    await user.type(screen.getByTestId('req-name-input'), 'Платежи');
    expect(await screen.findByTestId('req-name-error')).toHaveTextContent(
      'Функция с таким именем уже существует',
    );
    expect(screen.getByTestId('req-apply')).toBeDisabled();
  });

  it('surfaces an API error returned on save', async () => {
    create.mockRejectedValueOnce(new ApiError(422, { code: 'VALIDATION', message: 'Плохие данные' }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={onClose} />);

    await user.click(screen.getByTestId('req-implemented-yes')); // avoid quarter/year requirement
    await user.type(screen.getByTestId('req-name-input'), 'Новая функция');
    await screen.findByTestId('req-name-ok');

    await user.click(screen.getByTestId('req-apply'));
    expect(await screen.findByTestId('req-error')).toHaveTextContent('Плохие данные');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks for confirmation before saving an edit (FR-6.5)', async () => {
    update.mockResolvedValueOnce({});
    const onClose = vi.fn();
    const user = userEvent.setup();
    const requirement = {
      id: 'r1',
      type: 'FUNCTION' as const,
      name: 'Платежи',
      criticality: 'HIGH' as const,
      description: '',
      implemented: true,
      links: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    renderWithProviders(
      <RequirementModal projectId="p1" reqType="FUNCTION" requirement={requirement} onClose={onClose} />,
    );

    await user.type(screen.getByTestId('req-name-input'), ' v2');
    await screen.findByTestId('req-name-ok');
    await user.click(screen.getByTestId('req-apply'));

    // Save confirmation dialog appears instead of saving immediately.
    expect(await screen.findByTestId('req-save-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('req-save-confirm-confirm'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
