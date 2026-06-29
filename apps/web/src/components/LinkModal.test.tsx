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

const source = makeReq({ id: 's1', name: 'Сохранение карты' });
const requirements = [
  source,
  makeReq({ id: 'a1', name: 'Оплата картой' }),
  makeReq({ id: 'a2', name: 'Возвраты' }),
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
});
