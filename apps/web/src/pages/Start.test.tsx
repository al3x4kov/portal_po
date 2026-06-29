import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Start } from './Start';
import { renderWithProviders } from '../test/utils';

describe('Start page (T-602)', () => {
  it('shows three navigation actions linking to New / Import / Open', () => {
    renderWithProviders(<Start />);
    expect(screen.getByTestId('start-new')).toHaveAttribute('href', '/new');
    expect(screen.getByTestId('start-import')).toHaveAttribute('href', '/import');
    expect(screen.getByTestId('start-open')).toHaveAttribute('href', '/open');
    expect(screen.getByText('Новый проект')).toBeInTheDocument();
    expect(screen.getByText('Открыть существующий')).toBeInTheDocument();
  });
});
