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
});
