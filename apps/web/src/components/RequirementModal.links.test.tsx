import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementModal } from './RequirementModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';
import { ApiError } from '../api/client';

/**
 * Task 12 · F-1 (ARC-T1): link sections ФТ/НФТ inside the modal, infoItems
 * handlers, error branches (uniqueness, API refusal on save / link ops) and
 * the cancel/save confirmation flows.
 */

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
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({ baseURL: '', hasApiKey: false }),
    saveConfig: vi.fn(),
    listModels: vi.fn(),
    generateDescription: vi.fn(),
  },
}));

describe('RequirementModal — link sections & error branches (Task 12 · F-1)', () => {
  beforeEach(() => {
    checkName.mockReset();
    create.mockReset();
    update.mockReset();
    linkCreate.mockReset();
    linkRemove.mockReset();
    checkName.mockResolvedValue({ available: true, slug: 'x' });
  });

  // ── T-517 · classification of links into ФТ / НФТ sections ────────────────
  it('classifies links by target type: NFR targets go to «Связи с НФТ», hierarchy and FT targets to «Связи с ФТ»', async () => {
    const user = userEvent.setup();
    const requirement = makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [
        { type: 'CHILD_OF', targetSlug: 'payments' },
        { type: 'RELATES_TO', targetSlug: 'refunds' },
        { type: 'BLOCKED_BY', targetSlug: 'pci' },
      ],
    });
    const requirementsBySlug = new Map([
      ['payments', makeReq({ slug: 'payments', name: 'Платежи' })],
      ['refunds', makeReq({ slug: 'refunds', name: 'Возвраты' })],
      ['pci', makeReq({ slug: 'pci', name: 'Соответствие PCI DSS', type: 'NFR' })],
    ]);
    const nameBySlug = new Map([
      ['payments', 'Платежи'],
      ['refunds', 'Возвраты'],
      ['pci', 'Соответствие PCI DSS'],
    ]);
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        requirementsBySlug={requirementsBySlug}
        nameBySlug={nameBySlug}
        onClose={vi.fn()}
      />,
    );

    const ftSection = screen.getByTestId('req-links-ft');
    const nfrSection = screen.getByTestId('req-links-nfr');
    // Counters reflect the split: 2 ФТ links (hierarchy + FT target), 1 НФТ.
    expect(ftSection).toHaveTextContent('Связи с ФТ (2)');
    expect(nfrSection).toHaveTextContent('Связи с НФТ (1)');
    // Non-hierarchy FT link is visible right away.
    expect(within(ftSection).getByTestId('req-link-refunds')).toBeInTheDocument();
    // Hierarchy links (CHILD_OF) are collapsed by default — expand to see them.
    await user.click(within(ftSection).getByTestId('req-links-hierarchy-toggle'));
    expect(within(ftSection).getByTestId('req-link-payments')).toBeInTheDocument();
    expect(within(nfrSection).getByTestId('req-link-pci')).toBeInTheDocument();
    // No empty states while both sections have rows.
    expect(screen.queryByTestId('req-links-ft-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('req-links-nfr-empty')).not.toBeInTheDocument();
  });

  it('NFR section shows its empty state while FT links exist (and vice versa is covered elsewhere)', () => {
    const requirement = makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [{ type: 'PARENT_OF', targetSlug: 'child' }],
    });
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={requirement}
        requirementsBySlug={new Map([['child', makeReq({ slug: 'child', name: 'Дочка' })]])}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('req-links-ft-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('req-links-nfr-empty')).toHaveTextContent('Нет связей с НФТ');
  });

  // ── T-517 · opening the picker (LinkModal) from the modal ─────────────────
  it('«+ Связать с ФТ» / «+ Связать с НФТ» call onAddLink with the right type hint', async () => {
    const onAddLink = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой', links: [] })}
        onAddLink={onAddLink}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('req-links-add-ft'));
    expect(onAddLink).toHaveBeenCalledWith('FUNCTION');
    await user.click(screen.getByTestId('req-links-add-nfr'));
    expect(onAddLink).toHaveBeenCalledWith('NFR');
    expect(onAddLink).toHaveBeenCalledTimes(2);
  });

  it('without onAddLink the «+ Связать…» buttons are not rendered', () => {
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой', links: [] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('req-links-add-ft')).not.toBeInTheDocument();
    expect(screen.queryByTestId('req-links-add-nfr')).not.toBeInTheDocument();
  });

  // ── Error branches ─────────────────────────────────────────────────────────
  it('link deletion failure: shows the API error and keeps the link in the list', async () => {
    linkRemove.mockRejectedValueOnce(
      new ApiError(500, { code: 'IO', message: 'Не удалось записать файл' }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({
          slug: 'card',
          name: 'Оплата картой',
          links: [{ type: 'BLOCKED_BY', targetSlug: 'pci' }],
        })}
        nameBySlug={new Map([['pci', 'Соответствие PCI DSS']])}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('req-link-del-pci'));
    await user.click(screen.getByTestId('req-link-del-confirm'));

    expect(await screen.findByTestId('req-error')).toHaveTextContent('Не удалось записать файл');
    // The link must NOT disappear — data is not lost on a failed delete.
    expect(screen.getByTestId('req-link-pci')).toBeInTheDocument();
  });

  it('update failure in edit mode: error shown, modal stays open, edits are not lost', async () => {
    update.mockRejectedValueOnce(new ApiError(409, { code: 'CONFLICT', message: 'Файл изменён' }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой' })}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByTestId('req-name'), ' v2');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );
    await user.click(screen.getByTestId('req-submit'));
    await user.click(await screen.findByTestId('req-save-confirm-confirm'));

    expect(await screen.findByTestId('req-error')).toHaveTextContent('Файл изменён');
    expect(onClose).not.toHaveBeenCalled();
    // The typed value survives the failed save.
    expect(screen.getByTestId('req-name')).toHaveValue('Оплата картой v2');
  });

  it('preset-link creation failure: requirement created, link error surfaced, modal not closed', async () => {
    create.mockResolvedValueOnce({ slug: 'pci-dss' });
    linkCreate.mockRejectedValueOnce(
      new ApiError(422, { code: 'CYCLE', message: 'Связь создаёт цикл' }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="NFR"
        nameBySlug={new Map([['card', 'Оплата картой']])}
        linkFrom="card"
        linkType="BLOCKED_BY"
        onClose={onClose}
      />,
    );

    await user.click(screen.getByTestId('req-implemented-yes'));
    await user.type(screen.getByTestId('req-name'), 'PCI DSS');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );
    await user.click(screen.getByTestId('req-submit'));

    expect(await screen.findByTestId('req-error')).toHaveTextContent('Связь создаёт цикл');
    expect(create).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uniqueness check for an NFR shows the NFR-specific «занято» message', async () => {
    checkName.mockResolvedValue({ available: false, slug: 'nadezhnost' });
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="NFR" onClose={vi.fn()} />);

    await user.type(screen.getByTestId('req-name'), 'Надёжность');
    const status = await screen.findByTestId('req-name-status');
    expect(status).toHaveTextContent('НФТ с таким именем уже существует');
    expect(screen.getByTestId('req-submit')).toBeDisabled();
  });

  // ── Cancel / save confirmations ────────────────────────────────────────────
  it('dirty edit + «Отменить»: confirm dialog, «Продолжить редактирование» keeps the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой' })}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByTestId('req-name'), ' изм');
    await user.click(screen.getByTestId('req-cancel'));
    const confirm = await screen.findByTestId('req-cancel-confirm');
    expect(confirm).toHaveTextContent('Несохранённые изменения будут потеряны');

    await user.click(screen.getByTestId('req-cancel-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('req-cancel-confirm')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    // Confirming the second time really closes without saving.
    await user.click(screen.getByTestId('req-cancel'));
    await user.click(await screen.findByTestId('req-cancel-confirm-confirm'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('non-dirty edit + «Отменить» closes immediately without confirmation', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой' })}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('req-cancel'));
    expect(screen.queryByTestId('req-cancel-confirm')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('save confirmation can be dismissed: no update call, modal stays open', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({ slug: 'card', name: 'Оплата картой' })}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('req-name'), ' v2');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );
    await user.click(screen.getByTestId('req-submit'));
    await user.click(await screen.findByTestId('req-save-confirm-cancel'));

    await waitFor(() => expect(screen.queryByTestId('req-save-confirm')).not.toBeInTheDocument());
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByTestId('requirement-modal')).toBeInTheDocument();
  });

  // ── FR-20 · infoItems handlers ─────────────────────────────────────────────
  it('FR-20: adds an info item and sends it in the create payload', async () => {
    create.mockResolvedValueOnce({ slug: 'x' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={onClose} />);

    await user.click(screen.getByTestId('info-add-btn'));
    // Apply is disabled until both «тип» and «значение» are filled.
    expect(screen.getByTestId('info-apply-btn')).toBeDisabled();
    await user.type(screen.getByTestId('info-type-input'), 'Ссылка');
    await user.type(screen.getByTestId('info-value-input'), 'https://wiki/req-1');
    await user.click(screen.getByTestId('info-apply-btn'));

    // Item rendered, inline form gone.
    expect(screen.getByText('Ссылка')).toBeInTheDocument();
    expect(screen.getByText('https://wiki/req-1')).toBeInTheDocument();
    expect(screen.queryByTestId('info-type-input')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('req-implemented-yes'));
    await user.type(screen.getByTestId('req-name'), 'Функция со справкой');
    await waitFor(() =>
      expect(screen.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok'),
    );
    await user.click(screen.getByTestId('req-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toMatchObject({
      infoItems: [{ type: 'Ссылка', value: 'https://wiki/req-1' }],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('FR-20: the inline add form can be cancelled and clears its inputs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RequirementModal projectId="p1" reqType="FUNCTION" onClose={vi.fn()} />);

    await user.click(screen.getByTestId('info-add-btn'));
    await user.type(screen.getByTestId('info-type-input'), 'Автор');
    await user.click(screen.getByTestId('info-cancel-btn'));
    expect(screen.queryByTestId('info-type-input')).not.toBeInTheDocument();

    // Reopen: inputs start empty again.
    await user.click(screen.getByTestId('info-add-btn'));
    expect(screen.getByTestId('info-type-input')).toHaveValue('');
    expect(screen.getByTestId('info-value-input')).toHaveValue('');
  });

  it('FR-20: deleting an info item asks inline; «Нет» keeps it, «Да» removes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        requirement={makeReq({
          slug: 'card',
          name: 'Оплата картой',
          infoItems: [{ type: 'Автор', value: 'ИИ' }],
        })}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('info-delete-0'));
    expect(screen.getByText('Удалить?')).toBeInTheDocument();
    await user.click(screen.getByTestId('info-delete-cancel-0'));
    expect(screen.getByText('Автор')).toBeInTheDocument();

    await user.click(screen.getByTestId('info-delete-0'));
    await user.click(screen.getByTestId('info-delete-confirm-0'));
    expect(screen.queryByText('Автор')).not.toBeInTheDocument();
  });

  // ── T-515 · focusField ─────────────────────────────────────────────────────
  it('T-515: focusField="description" moves focus into the description textarea', async () => {
    renderWithProviders(
      <RequirementModal
        projectId="p1"
        reqType="FUNCTION"
        focusField="description"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('req-description')).toHaveFocus());
  });
});
