import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Criticality } from '@po/core';
import { CriticalityBadge, ImplementationBadge } from './badges';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';
import { makeReq } from '../test/fixtures';

describe('CriticalityBadge', () => {
  const levels: Criticality[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BLOCKER'];

  it.each(levels)('renders the %s label and its dot color', (level) => {
    render(<CriticalityBadge criticality={level} />);
    const badge = screen.getByTestId('criticality-badge');
    expect(badge).toHaveTextContent(CRITICALITY_LABEL[level]);
    const dot = badge.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(dot.style.background).toBe(CRITICALITY_COLOR_VAR[level]);
  });
});

describe('ImplementationBadge', () => {
  it('shows "Реализовано" (success) when the requirement is implemented', () => {
    render(<ImplementationBadge req={makeReq({ slug: 'r1', name: 'A', implemented: true })} />);
    const badge = screen.getByTestId('implementation-badge');
    expect(badge).toHaveTextContent('Реализовано');
    expect(badge.style.background).toBe('var(--color-success-bg)');
  });

  it('shows the quarter + year (warning) when not implemented and both are set', () => {
    render(
      <ImplementationBadge
        req={makeReq({
          slug: 'r2',
          name: 'B',
          implemented: false,
          targetQuarter: 'Q3',
          targetYear: 2026,
        })}
      />,
    );
    const badge = screen.getByTestId('implementation-badge');
    expect(badge).toHaveTextContent('Q3 2026');
    expect(badge.style.background).toBe('var(--color-warning-bg)');
  });

  it('shows only the quarter when the year is missing', () => {
    render(
      <ImplementationBadge
        req={makeReq({ slug: 'r3', name: 'C', implemented: false, targetQuarter: 'Q1' })}
      />,
    );
    expect(screen.getByTestId('implementation-badge')).toHaveTextContent('Q1');
  });

  it('falls back to "Не реализовано" when not implemented and no quarter/year', () => {
    render(<ImplementationBadge req={makeReq({ slug: 'r4', name: 'D', implemented: false })} />);
    expect(screen.getByTestId('implementation-badge')).toHaveTextContent('Не реализовано');
  });
});
