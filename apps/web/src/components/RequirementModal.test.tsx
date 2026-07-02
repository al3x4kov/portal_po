import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementModal } from './RequirementModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';
import { ApiError } from '../api/client';

const checkName = vi.fn();
const create = vi.fn();
const update = vi.fn();
const linkCreate = vi.fn();
const linkRemove = vi.fn();

vi.mock('../api/endpoints', () => ({
  requirementsApi: {
    checkName: (...a: unknown[]) => checkName(...a),
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    list: vi.fn(),
    remove: vi.fn(),
  },
  projectsApi: {},
  linksApi: {
    create: (...a: unknown[]) => linkCreate(...a),
    remove: (...a: unknown[]) => linkRemove(...a),
  },
}));

describe('RequirementModal (T-1106, FR-6)', () => {
  beforeEach(() => {
    checkName.mockReset();
    create.mockReset();
    update.mockReset();
    linkCreate.mockReset();
    linkRemove.mockReset();
    checkName.mockResolvedValue({ available: true, slug: 'x' });
  });

  it('shows the type badge and a live character counter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="NFR" onClose={vi.fn()} />);
    expect(screen.getByTestId('requirement-modal-badge')).toHaveTextContent('Нефункциональное');
    expect(screen.getByTestId('req-desc-count')).toHaveTextContent('0 / 5000');
    await user.type(screen.getByTestId('req-description'), 'Привет');
    expect(screen.getByTestId('req-desc-count')).toHaveTextContent('6 / 5000');
  });

  it('shows quarter/year only while "не реализовано" selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />);

    expect(screen.getByTestId('req-target')).toBeInTheDocument();
    await user.click(screen.getByTestId('req-implemented-yes'));
    expect(screen.queryByTestId('req-target')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('req-implemented-no'));
    expect(screen.getByTestId('req-target')).toBeInTheDocument();
  });

  it('blocks "Сохранить" when the name is a duplicate (FR-6.6)', async () => {
    checkName.mockResolvedValue({ available: false, slug: 'platezhi' });
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />);

    await user.type(screen.getByTestId('req-name'), 'Платежи');
    const status = await screen.findByTestId('req-name-status');
    expect(status).toHaveTextContent('Функция с таким именем уже существует');
    expect(screen.getByTestId('req-submit')).toBeDisabled();
  });

  it('surfaces an API error returned on save', async () => {
    create.mockRejectedValueOnce(
      new ApiError(422, { code: 'VALIDATION', message: 'Плохие данные' }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={onClose} />);

    await user.click(screen.getByTestId('req-implemented-yes')); // avoid quarter/year requirement
    await user.type(screen.getByTestId('req-name'), 'Новая функция');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );

    await user.click(screen.getByTestId('req-submit'));
    expect(await screen.findByTestId('req-error')).toHaveTextContent('Плохие данные');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks for confirmation before saving an edit (FR-6.5)', async () => {
    update.mockResolvedValueOnce({});
    const onClose = vi.fn();
    const user = userEvent.setup();
    const requirement = {
      slug: 'r1',
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
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByTestId('req-name'), ' v2');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );
    await user.click(screen.getByTestId('req-submit'));

    expect(await screen.findByTestId('req-save-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('req-save-confirm-confirm'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ── T2 · links block in edit mode ───────────────────────────────────────────
  it('T2: lists the requirement links with readable labels and target names', () => {
    const requirement = makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [
        { type: 'BLOCKED_BY', targetSlug: 'pci' },
        { type: 'RELATES_TO', targetSlug: 'tds' },
      ],
    });
    const nameBySlug = new Map([
      ['pci', 'Соответствие PCI DSS'],
      ['tds', '3-D Secure'],
    ]);
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        nameBySlug={nameBySlug}
        onClose={vi.fn()}
      />,
    );
    // T-517: links section is split into FT and NFR; without requirementsBySlug all non-hierarchy
    // links fall back to the FT section.
    expect(screen.getByTestId('req-links-ft')).toBeInTheDocument();
    expect(screen.getByTestId('req-links-nfr')).toBeInTheDocument();
    const blocked = screen.getByTestId('req-link-pci');
    expect(blocked).toHaveAttribute('data-link-type', 'BLOCKED_BY');
    expect(blocked).toHaveTextContent('блокируется');
    expect(blocked).toHaveTextContent('Соответствие PCI DSS');
    expect(screen.getByTestId('req-link-tds')).toHaveTextContent('3-D Secure');
    expect(screen.queryByTestId('req-links-ft-empty')).not.toBeInTheDocument();
  });

  it('T2: shows an explicit empty state when the requirement has no links', () => {
    const requirement = makeReq({ slug: 'card', name: 'Оплата картой', links: [] });
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        onClose={vi.fn()}
      />,
    );
    // T-517: empty state is now per-section; both FT and NFR sections show their own empty state.
    expect(screen.getByTestId('req-links-ft-empty')).toHaveTextContent('Нет связей с ФТ');
    expect(screen.getByTestId('req-links-nfr-empty')).toHaveTextContent('Нет связей с НФТ');
    // No link rows should be present.
    expect(screen.queryAllByTestId(/^req-link-/)).toHaveLength(0);
  });

  it('T2: a brand-new requirement shows no links block at all', () => {
    renderWithProviders(<RequirementModal projectId="p1" reqType="NFR" onClose={vi.fn()} />);
    // T-517: new requirement has no links block at all (isEdit=false).
    expect(screen.queryByTestId('req-links-ft')).not.toBeInTheDocument();
    expect(screen.queryByTestId('req-links-nfr')).not.toBeInTheDocument();
  });

  // ── T3 · inline delete of a link ─────────────────────────────────────────────
  it('T3: deleting a link confirms inline then calls useDeleteLink with the right input', async () => {
    linkRemove.mockResolvedValueOnce({ ok: true });
    const requirement = makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [{ type: 'BLOCKED_BY', targetSlug: 'pci' }],
    });
    const nameBySlug = new Map([['pci', 'Соответствие PCI DSS']]);
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        nameBySlug={nameBySlug}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('req-link-del-pci'));
    expect(screen.getByTestId('req-link-del-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('req-link-del-confirm'));

    await waitFor(() =>
      expect(linkRemove).toHaveBeenCalledWith('p1', {
        sourceSlug: 'card',
        type: 'BLOCKED_BY',
        targetSlug: 'pci',
      }),
    );
    // Link disappears after a successful deletion.
    await waitFor(() => expect(screen.queryByTestId('req-link-pci')).not.toBeInTheDocument());
  });

  it('T3: cancelling the inline delete leaves the link intact', async () => {
    const requirement = makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [{ type: 'BLOCKED_BY', targetSlug: 'pci' }],
    });
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('req-link-del-pci'));
    await user.click(screen.getByTestId('req-link-del-cancel'));

    expect(linkRemove).not.toHaveBeenCalled();
    expect(screen.getByTestId('req-link-pci')).toBeInTheDocument();
    expect(screen.queryByTestId('req-link-del-confirm')).not.toBeInTheDocument();
  });

  // ── T4 · create NFR from a functional requirement (preset BLOCKED_BY) ─────────
  it('T4: shows the preset-link hint and creates the NFR then the link', async () => {
    create.mockResolvedValueOnce({ slug: 'sootvetstvie-pci-dss' });
    linkCreate.mockResolvedValueOnce({ ok: true });
    const onClose = vi.fn();
    const nameBySlug = new Map([['card', 'Оплата картой']]);
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="NFR"
        nameBySlug={nameBySlug}
        linkFrom="card"
        linkType="BLOCKED_BY"
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('nfr-from-ft-hint')).toHaveTextContent('Оплата картой');

    await user.click(screen.getByTestId('req-implemented-yes')); // avoid quarter/year requirement
    await user.type(screen.getByTestId('req-name'), 'Соответствие PCI DSS');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );

    await user.click(screen.getByTestId('req-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(linkCreate).toHaveBeenCalledWith('p1', {
        sourceSlug: 'card',
        type: 'BLOCKED_BY',
        targetSlug: 'sootvetstvie-pci-dss',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
