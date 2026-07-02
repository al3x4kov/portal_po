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

  it('shows the readable relationship sentence after picking a target', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LinkModal projectId="p1" source={source} requirements={requirements} onClose={vi.fn()} />,
    );
    await user.type(screen.getByTestId('link-search'), 'Оплата');
    await user.click(screen.getByTestId('link-result-a1'));
    const sentence = screen.getByTestId('link-sentence');
    expect(sentence).toHaveTextContent('«Сохранение карты»');
    expect(sentence).toHaveTextContent('является дочерней для');
    expect(sentence).toHaveTextContent('«Оплата картой»');
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
    // default type is CHILD_OF
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
    await user.selectOptions(screen.getByTestId('link-type'), 'RELATES_TO');
    await user.type(screen.getByTestId('link-search'), 'НФТ');
    const target = screen.getByTestId('link-result-nfr');
    expect(target).not.toBeDisabled();
    await user.click(target);
    expect(screen.getByTestId('link-submit')).not.toBeDisabled();
  });
});
