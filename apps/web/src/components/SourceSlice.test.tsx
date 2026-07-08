import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourcePriority } from '@po/core';
import { SourceSlice } from './SourceSlice';
import { makeReq } from '../test/fixtures';

const PRIORITIES: SourcePriority[] = [
  { id: 'p-crit', name: 'Критично для сделки', color: 'red', order: 0 },
  { id: 'default', name: 'Квартальная цель', color: 'amber', order: 1 },
];

describe('SourceSlice (T-208)', () => {
  it('places a requirement with N sources into N groups with its own priority', () => {
    const req = makeReq({
      slug: 'exp',
      name: 'Экспорт реестра',
      sources: [
        { type: 'CLIENT', name: 'Альфа', priorityId: 'p-crit' },
        { type: 'STAKEHOLDER', name: 'Иванов', priorityId: 'default' },
      ],
    });
    render(<SourceSlice requirements={[req]} priorities={PRIORITIES} onOpen={vi.fn()} />);
    // Two groups.
    expect(screen.getByTestId('slice-group-Альфа')).toBeInTheDocument();
    expect(screen.getByTestId('slice-group-Иванов')).toBeInTheDocument();
    // Same requirement, different priority per group.
    const alphaItem = screen.getByTestId('slice-item-Альфа-exp');
    expect(alphaItem).toHaveTextContent('Критично для сделки');
    const ivanovItem = screen.getByTestId('slice-item-Иванов-exp');
    expect(ivanovItem).toHaveTextContent('Квартальная цель');
  });

  it('rolls up per-group priority counters', () => {
    const a = makeReq({
      slug: 'a',
      name: 'A',
      sources: [{ type: 'CLIENT', name: 'Альфа', priorityId: 'p-crit' }],
    });
    const b = makeReq({
      slug: 'b',
      name: 'B',
      sources: [{ type: 'CLIENT', name: 'Альфа', priorityId: 'p-crit' }],
    });
    render(<SourceSlice requirements={[a, b]} priorities={PRIORITIES} onOpen={vi.fn()} />);
    expect(screen.getByTestId('slice-count-Альфа-p-crit')).toHaveTextContent('× 2');
  });

  it('shows an empty state when no requirement has sources', () => {
    const req = makeReq({ slug: 'x', name: 'Без источников' });
    render(<SourceSlice requirements={[req]} priorities={PRIORITIES} onOpen={vi.fn()} />);
    expect(screen.getByTestId('source-slice-empty')).toBeInTheDocument();
  });

  it('opens the requirement when its slice item is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const req = makeReq({
      slug: 'exp',
      name: 'Экспорт реестра',
      sources: [{ type: 'CLIENT', name: 'Альфа', priorityId: 'p-crit' }],
    });
    render(<SourceSlice requirements={[req]} priorities={PRIORITIES} onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: /Экспорт реестра/ }));
    expect(onOpen).toHaveBeenCalledWith(req);
  });

  it('drops unknown priorities from counters and hides a missing item badge', () => {
    const req = makeReq({
      slug: 'exp',
      name: 'Экспорт реестра',
      sources: [{ type: 'CLIENT', name: 'Альфа', priorityId: 'ghost' }],
    });
    render(<SourceSlice requirements={[req]} priorities={PRIORITIES} onOpen={vi.fn()} />);
    // The group still renders (source name is known) but carries no counter chips
    // and the item has no priority badge because «ghost» is not in the dictionary.
    expect(screen.getByTestId('slice-group-Альфа')).toBeInTheDocument();
    expect(screen.getByTestId('slice-counts-Альфа')).toBeEmptyDOMElement();
    const item = screen.getByTestId('slice-item-Альфа-exp');
    expect(item).toHaveTextContent('Экспорт реестра');
    expect(item.querySelector('[data-testid^="slice-item-prio-"]')).toBeNull();
  });
});
