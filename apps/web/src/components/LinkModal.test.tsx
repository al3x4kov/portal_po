import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkModal } from './LinkModal';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';
import { makeReq } from '../test/fixtures';

const createLink = vi.fn();

vi.mock('../api/endpoints', () => ({
  linksApi: {
    create: (...a: unknown[]) => createLink(...a),
    remove: vi.fn(),
  },
  projectsApi: {},
  requirementsApi: {},
}));

const source = makeReq({ slug: 's1', name: 'Сохранение карты' });
const requirements = [
  source,
  makeReq({ slug: 'a1', name: 'Оплата картой' }),
  makeReq({ slug: 'a2', name: 'Возвраты' }),
];

describe('LinkModal (T-606, FR-8)', () => {
  beforeEach(() => createLink.mockReset());

  it('filters candidates by name and excludes the source', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    expect(screen.getByTestId('link-result-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('link-result-a2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('link-result-s1')).not.toBeInTheDocument();
  });

  it('explains why «Связать» is disabled until a target is picked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    // No target yet → button disabled with a visible reason.
    expect(screen.getByTestId('link-submit')).toBeDisabled();
    expect(screen.getByTestId('link-submit-hint')).toHaveTextContent(
      'Выберите требование для связи',
    );
    // Pick a compatible target → hint disappears and the button enables.
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    await user.click(screen.getByTestId('link-result-a1'));
    expect(screen.queryByTestId('link-submit-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('link-submit')).toBeEnabled();
  });

  it('T4: link types are radio cards in the mockup order, «Двусторонняя связь» is the default', () => {
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    const radios = screen
      .getAllByRole('radio')
      .map((r) => (r as HTMLInputElement).value) as string[];
    expect(radios).toEqual(['RELATES_TO', 'CHILD_OF', 'PARENT_OF', 'DEPENDS_ON', 'BLOCKED_BY']);
    // §2.11: the safe symmetric type is pre-selected, not CHILD_OF.
    expect(screen.getByTestId('link-type-RELATES_TO')).toBeChecked();
    expect(screen.getByText('Двусторонняя связь')).toBeInTheDocument();
    expect(screen.getByText('Дочернее для цели')).toBeInTheDocument();
  });

  it('shows the readable relationship sentence with highlighted names after picking a target', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    await user.click(screen.getByTestId('link-result-a1'));

    // Default RELATES_TO — symmetric sentence.
    let sentence = screen.getByTestId('link-sentence');
    expect(sentence).toHaveTextContent('«Сохранение карты»');
    expect(sentence).toHaveTextContent('будут связаны двусторонней связью');
    expect(sentence).toHaveTextContent('«Оплата картой»');

    // CHILD_OF — the target becomes the parent (mockup wording).
    await user.click(screen.getByTestId('link-type-CHILD_OF'));
    sentence = screen.getByTestId('link-sentence');
    expect(sentence).toHaveTextContent('«Оплата картой» станет родителем «Сохранение карты»');
  });

  it('T4: the search field stays a search field; the chosen target is a chip with a reset ✕', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    await user.click(screen.getByTestId('link-result-a1'));

    // The input keeps the typed query — it is not overwritten by the selection.
    expect(screen.getByTestId('link-search')).toHaveValue('Оплата');
    expect(screen.getByTestId('link-target-chip')).toHaveTextContent('Цель: «Оплата картой»');

    // Reset clears the selection and disables submit again.
    await user.click(screen.getByTestId('link-target-reset'));
    expect(screen.queryByTestId('link-target-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('link-submit')).toBeDisabled();
  });

  it('T4: shows «первые 25 из N» when the result list is truncated', async () => {
    const user = userEvent.setup();
    const many = [
      source,
      ...Array.from({ length: 30 }, (_, i) =>
        makeReq({ slug: `m${i}`, name: `Массовое требование ${i}` }),
      ),
    ];
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={many} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('link-results-more')).toHaveTextContent(
      'Показаны первые 25 из 30 — уточните запрос',
    );
    // Narrowing the query removes the truncation notice.
    await user.type(screen.getByTestId('link-search'), 'Массовое требование 1');
    expect(screen.queryByTestId('link-results-more')).not.toBeInTheDocument();
  });

  it('displays an integrity error returned by the API', async () => {
    createLink.mockRejectedValueOnce(
      new ApiError(409, { code: 'CYCLE', message: 'Cycle detected: a -> b -> a' }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    await user.click(screen.getByTestId('link-result-a1'));
    await user.click(screen.getByTestId('link-submit'));
    expect(await screen.findByTestId('link-error')).toHaveTextContent('Cycle detected');
  });

  // ── UX-4 · prevent incompatible hierarchical targets ─────────────────────────
  it('UX-4: for CHILD_OF a different-type target is disabled with a reason', async () => {
    const user = userEvent.setup();
    const fn = makeReq({ slug: 'fn', name: 'Функция источник', type: 'FUNCTION' });
    const nfr = makeReq({ slug: 'nfr', name: 'НФТ доступность', type: 'NFR' });
    renderWithProviders(
      <LinkModal projectId="p1" source={fn} requirements={[fn, nfr]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('link-type-CHILD_OF'));
    await user.type(screen.getByTestId('link-search'), 'НФТ');
    const target = screen.getByTestId('link-result-nfr');
    expect(target).toBeDisabled();
    expect(screen.getByTestId('link-result-reason-nfr')).toHaveTextContent(/тип/i);
  });

  it('UX-4: for CHILD_OF a target that would create a cycle is disabled', async () => {
    const user = userEvent.setup();
    const parent = makeReq({
      slug: 'p',
      name: 'Родитель узел',
      links: [{ type: 'PARENT_OF', targetSlug: 'c' }],
    });
    const child = makeReq({
      slug: 'c',
      name: 'Дочерний узел',
      links: [{ type: 'CHILD_OF', targetSlug: 'p' }],
    });
    renderWithProviders(
      <LinkModal projectId="p1" source={parent} requirements={[parent, child]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('link-type-CHILD_OF'));
    await user.type(screen.getByTestId('link-search'), 'Дочерний');
    expect(screen.getByTestId('link-result-c')).toBeDisabled();
    expect(screen.getByTestId('link-result-reason-c')).toHaveTextContent(/цикл/i);
  });

  it('UX-4: for CHILD_OF a second parent is disabled when the source already has one', async () => {
    const user = userEvent.setup();
    const p1 = makeReq({
      slug: 'p1',
      name: 'Первый родитель',
      links: [{ type: 'PARENT_OF', targetSlug: 'c' }],
    });
    const c = makeReq({
      slug: 'c',
      name: 'Ребёнок узел',
      links: [{ type: 'CHILD_OF', targetSlug: 'p1' }],
    });
    const p2 = makeReq({ slug: 'p2', name: 'Второй родитель' });
    renderWithProviders(
      <LinkModal projectId="p1" source={c} requirements={[p1, c, p2]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('link-type-CHILD_OF'));
    await user.type(screen.getByTestId('link-search'), 'Второй');
    expect(screen.getByTestId('link-result-p2')).toBeDisabled();
    expect(screen.getByTestId('link-result-reason-p2')).toHaveTextContent(/родител/i);
  });

  it('UX-4: RELATES_TO is softer — a different-type target stays selectable', async () => {
    const user = userEvent.setup();
    const fn = makeReq({ slug: 'fn', name: 'Функция источник', type: 'FUNCTION' });
    const nfr = makeReq({ slug: 'nfr', name: 'НФТ доступность', type: 'NFR' });
    renderWithProviders(
      <LinkModal projectId="p1" source={fn} requirements={[fn, nfr]} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('link-type-RELATES_TO'));
    await user.type(screen.getByTestId('link-search'), 'НФТ');
    const target = screen.getByTestId('link-result-nfr');
    expect(target).not.toBeDisabled();
    await user.click(target);
    expect(screen.getByTestId('link-submit')).not.toBeDisabled();
  });
});
