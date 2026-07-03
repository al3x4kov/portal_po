import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementPickerModal } from './RequirementPickerModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const requirements = [
  makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION' }),
  makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION' }),
];

describe('RequirementPickerModal', () => {
  it('explains why the confirm button is disabled when nothing is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={requirements}
        initialSelected={new Set()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // 0 selected → confirm disabled with a visible reason.
    expect(screen.getByTestId('export-next')).toBeDisabled();
    expect(screen.getByTestId('export-next-hint')).toHaveTextContent(
      'Выберите хотя бы одно требование',
    );

    // Select all → hint disappears, button enables.
    await user.click(screen.getByTestId('export-toggle-all'));
    expect(screen.queryByTestId('export-next-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-next')).toBeEnabled();
  });

  it('renders named filter groups', () => {
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'Регламент' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // Each filter group has its own heading. «Источник» is present because
    // there are 2+ distinct sources.
    expect(screen.getByRole('group', { name: 'Критичность' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Реализация' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Источник' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Выбор' })).toBeInTheDocument();

    // «Выбор» group owns the toggle-all control and the counter.
    const selectGroup = screen.getByRole('group', { name: 'Выбор' });
    expect(selectGroup).toContainElement(screen.getByTestId('export-toggle-all'));
  });

  it('does not show the «Источник» group when there is a single distinct source', () => {
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'ас21' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Two rows but only one normalized source → group hidden.
    expect(screen.queryByRole('group', { name: 'Источник' })).not.toBeInTheDocument();
  });

  it('treats sources differing only by case as one, and filters both', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'ас21' }),
          makeReq({ slug: 'f3', name: 'Отчёты', type: 'FUNCTION', source: 'Регламент' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // «АС21» and «ас21» collapse to a single chip with the canonical label.
    const chips = screen.getAllByTestId(/^export-filter-src-/);
    const labels = chips.map((c) => c.textContent);
    expect(labels.filter((l) => l && /ас21/i.test(l))).toHaveLength(1);
    // Canonical label is the first original spelling seen.
    expect(screen.getByTestId('export-filter-src-АС21')).toBeInTheDocument();

    // Filtering by that chip catches BOTH «АС21» and «ас21» rows,
    // but excludes the «Регламент» row.
    await user.click(screen.getByTestId('export-filter-src-АС21'));
    expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
    expect(screen.getByTestId('export-item-f2')).toBeInTheDocument();
    expect(screen.queryByTestId('export-item-f3')).not.toBeInTheDocument();
  });

  it('keeps existing criticality and select-all behaviour working', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', criticality: 'CRITICAL' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', criticality: 'LOW' }),
        ]}
        initialSelected={new Set()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // Filter by criticality CRITICAL → only f1 remains.
    await user.click(screen.getByTestId('export-filter-crit-CRITICAL'));
    expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
    expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();

    // Toggle-all selects the visible (filtered) row.
    await user.click(screen.getByTestId('export-toggle-all'));
    expect(screen.getByTestId('export-next')).toBeEnabled();
  });
});
