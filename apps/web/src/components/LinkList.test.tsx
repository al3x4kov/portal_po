import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Link } from '@po/core';
import { LinkList } from './LinkList';

function setup(overrides: Partial<React.ComponentProps<typeof LinkList>> = {}) {
  const props: React.ComponentProps<typeof LinkList> = {
    links: [],
    pendingDelete: null,
    deleting: false,
    onRequestDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    ...overrides,
  };
  render(<LinkList {...props} />);
  return props;
}

const relatesLink: Link = { type: 'RELATES_TO', targetSlug: 'a1' };
const dependsLink: Link = { type: 'DEPENDS_ON', targetSlug: 'a2' };
const parentLink: Link = { type: 'PARENT_OF', targetSlug: 'p1' };
const childLink: Link = { type: 'CHILD_OF', targetSlug: 'c1' };

const nameBySlug = new Map<string, string>([
  ['a1', 'Оплата картой'],
  ['a2', 'Возвраты'],
  ['p1', 'Платежи'],
  ['c1', 'Скидки'],
]);

describe('LinkList', () => {
  it('shows the empty state and the count (0) when there are no links', () => {
    setup({ links: [] });
    expect(screen.getByTestId('req-links-empty')).toHaveTextContent('Связей нет');
    expect(screen.queryByTestId('req-links')).not.toBeInTheDocument();
  });

  it('renders non-hierarchy links (always visible) with resolved target names', () => {
    setup({ links: [relatesLink, dependsLink], nameBySlug });
    const other = screen.getByTestId('req-links-other');
    expect(within(other).getByTestId('req-link-a1')).toHaveTextContent('Оплата картой');
    expect(within(other).getByTestId('req-link-a2')).toHaveTextContent('Возвраты');
    // hierarchy toggle is absent when there are no hierarchy links
    expect(screen.queryByTestId('req-links-hierarchy-toggle')).not.toBeInTheDocument();
  });

  it('falls back to the target slug when no name is known', () => {
    setup({ links: [relatesLink] });
    expect(screen.getByTestId('req-link-a1')).toHaveTextContent('a1');
  });

  it('collapses hierarchy links by default and expands them on toggle', async () => {
    const user = userEvent.setup();
    setup({ links: [parentLink, childLink], nameBySlug });
    const toggle = screen.getByTestId('req-links-hierarchy-toggle');
    expect(toggle).toHaveTextContent('Родитель / предок (2)');
    // collapsed: hierarchy rows not mounted
    expect(screen.queryByTestId('req-links-hierarchy')).not.toBeInTheDocument();
    await user.click(toggle);
    const region = screen.getByTestId('req-links-hierarchy');
    expect(within(region).getByTestId('req-link-p1')).toBeInTheDocument();
    expect(within(region).getByTestId('req-link-c1')).toBeInTheDocument();
    // toggle back closes it
    await user.click(toggle);
    expect(screen.queryByTestId('req-links-hierarchy')).not.toBeInTheDocument();
  });

  it('fires onRequestDelete with the link when the row remove button is clicked', async () => {
    const user = userEvent.setup();
    const props = setup({ links: [relatesLink], nameBySlug });
    await user.click(screen.getByTestId('req-link-del-a1'));
    expect(props.onRequestDelete).toHaveBeenCalledWith(relatesLink);
  });

  it('renders the inline confirm prompt for the pending link and wires cancel/confirm', async () => {
    const user = userEvent.setup();
    const props = setup({
      links: [relatesLink],
      nameBySlug,
      pendingDelete: { type: 'RELATES_TO', targetSlug: 'a1' },
    });
    // the normal remove button is replaced by the confirm prompt
    expect(screen.queryByTestId('req-link-del-a1')).not.toBeInTheDocument();
    expect(screen.getByTestId('req-link-del-cancel')).toBeInTheDocument();
    const confirm = screen.getByTestId('req-link-del-confirm');
    expect(confirm).toBeEnabled();
    await user.click(screen.getByTestId('req-link-del-cancel'));
    expect(props.onCancelDelete).toHaveBeenCalledTimes(1);
    await user.click(confirm);
    expect(props.onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button while a delete is in flight', () => {
    setup({
      links: [relatesLink],
      nameBySlug,
      pendingDelete: { type: 'RELATES_TO', targetSlug: 'a1' },
      deleting: true,
    });
    expect(screen.getByTestId('req-link-del-confirm')).toBeDisabled();
  });

  it('renders the "add link" button only when onAddLink is provided and fires it', async () => {
    const user = userEvent.setup();
    const onAddLink = vi.fn();
    setup({ links: [], onAddLink });
    await user.click(screen.getByTestId('req-links-add'));
    expect(onAddLink).toHaveBeenCalledTimes(1);
  });

  it('omits the "add link" button when onAddLink is not provided', () => {
    setup({ links: [] });
    expect(screen.queryByTestId('req-links-add')).not.toBeInTheDocument();
  });
});
