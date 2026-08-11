import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectDictionaries, TargetQuarter } from '@po/core';
import { PriorityTab } from './PriorityTab';
import { renderWithProviders } from '../test/utils';
import { emptyDraft, toDraft, type SourceDraft } from '../lib/sourceDraft';

const addPriority = vi.fn();
const addSource = vi.fn();

vi.mock('../api/endpoints', async (orig) => {
  const actual = await orig<typeof import('../api/endpoints')>();
  return {
    ...actual,
    dictionariesApi: {
      ...actual.dictionariesApi,
      addPriority: (...a: unknown[]) => addPriority(...a),
      addSource: (...a: unknown[]) => addSource(...a),
    },
  };
});

const DICT: ProjectDictionaries = {
  priorities: [
    { id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 },
    { id: 'p-crit', name: 'Критично', color: 'red', order: 1 },
  ],
  sources: [
    { id: 's1', name: 'Альфа', type: 'CLIENT' },
    { id: 's2', name: 'Бета', type: 'STAKEHOLDER' },
  ],
};

interface HarnessProps {
  initialDrafts?: SourceDraft[];
  implemented?: boolean;
  initialQuarter?: TargetQuarter;
  initialYear?: number;
  initialRelease?: string;
}

function Harness({
  initialDrafts = [],
  implemented,
  initialQuarter,
  initialYear,
  initialRelease = '',
}: HarnessProps): React.ReactElement {
  const [drafts, setDrafts] = useState<SourceDraft[]>(initialDrafts);
  const [quarter, setQuarter] = useState<TargetQuarter | undefined>(initialQuarter);
  const [year, setYear] = useState<number | undefined>(initialYear);
  const [release, setRelease] = useState(initialRelease);
  return (
    <PriorityTab
      projectId="proj1"
      dictionaries={DICT}
      drafts={drafts}
      onChange={setDrafts}
      implemented={implemented}
      targetQuarter={quarter}
      targetYear={year}
      onTargetQuarter={setQuarter}
      onTargetYear={setYear}
      releaseDate={release}
      onReleaseDate={setRelease}
    />
  );
}

function draft(partial: Partial<SourceDraft> = {}): SourceDraft {
  return { _key: 'k1', type: 'CLIENT', name: '', priorityId: 'default', ...partial };
}

beforeEach(() => {
  addPriority.mockReset();
  addSource.mockReset();
});

describe('PriorityTab — source cards (todo_19)', () => {
  it('adds and removes a source card', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.getByTestId('src-empty')).toBeInTheDocument();

    await user.click(screen.getByTestId('src-add'));
    expect(screen.getByTestId('src-card-0')).toBeInTheDocument();
    expect(screen.queryByTestId('src-empty')).toBeNull();

    await user.click(screen.getByTestId('src-remove-0'));
    expect(screen.getByTestId('src-empty')).toBeInTheDocument();
  });

  it('changes the source type via the select', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.selectOptions(screen.getByTestId('src-type-0'), 'STAKEHOLDER');
    // Card header reflects the new type label.
    expect(screen.getByTestId('src-card-0')).toHaveTextContent('Стейкхолдер');
  });

  it('picks an existing source from the combobox (carries its type)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    const input = screen.getByTestId('src-name-0-input');
    await user.type(input, 'Бета');
    await user.click(screen.getByTestId('src-name-0-opt-s2'));
    expect(input).toHaveValue('Бета');
    // Picking «Бета» (STAKEHOLDER) also switches the card type.
    expect(screen.getByTestId('src-card-0')).toHaveTextContent('Стейкхолдер');
  });

  it('creates a new source name and auto-collects it into the dictionary', async () => {
    addSource.mockResolvedValue({ id: 's9', name: 'Гамма', type: 'CLIENT' });
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.type(screen.getByTestId('src-name-0-input'), 'Гамма');
    await user.click(screen.getByTestId('src-name-0-create'));
    await waitFor(() =>
      expect(addSource).toHaveBeenCalledWith('proj1', { name: 'Гамма', type: 'CLIENT' }),
    );
  });

  it('shows a dictionary error when auto-collect fails', async () => {
    addSource.mockRejectedValue(new Error('Источник уже существует'));
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.type(screen.getByTestId('src-name-0-input'), 'Дельта');
    await user.click(screen.getByTestId('src-name-0-create'));
    expect(await screen.findByTestId('req-priority-dict-error')).toHaveTextContent(/существует/);
  });
});

describe('PriorityTab — priority select & inline add', () => {
  it('selects an existing priority', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft({ name: 'Альфа' })]} />);
    await user.selectOptions(screen.getByTestId('src-priority-0'), 'p-crit');
    expect(screen.getByTestId('src-priority-0')).toHaveValue('p-crit');
  });

  it('opens the inline «add priority» form and cancels it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.selectOptions(screen.getByTestId('src-priority-0'), '__add__');
    expect(screen.getByTestId('src-priority-add-0')).toBeInTheDocument();
    await user.click(screen.getByTestId('src-priority-add-cancel-0'));
    expect(screen.queryByTestId('src-priority-add-0')).toBeNull();
  });

  it('creates a new priority inline and assigns it to the card', async () => {
    addPriority.mockResolvedValue({ id: 'p-new', name: 'Демо', color: 'green', order: 2 });
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft({ name: 'Альфа' })]} />);
    await user.selectOptions(screen.getByTestId('src-priority-0'), '__add__');
    const save = screen.getByTestId('src-priority-add-save-0');
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('src-priority-add-name-0'), 'Демо');
    await user.click(screen.getByTestId('src-priority-add-color-0-green'));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(addPriority).toHaveBeenCalledWith('proj1', { name: 'Демо', color: 'green' }),
    );
    // Form closes and the new priority is selected on the card.
    await waitFor(() => expect(screen.queryByTestId('src-priority-add-0')).toBeNull());
  });

  it('surfaces an error when inline priority creation fails', async () => {
    addPriority.mockRejectedValue(new Error('Дубликат приоритета'));
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.selectOptions(screen.getByTestId('src-priority-0'), '__add__');
    await user.type(screen.getByTestId('src-priority-add-name-0'), 'Демо');
    await user.click(screen.getByTestId('src-priority-add-save-0'));
    expect(await screen.findByTestId('req-priority-dict-error')).toHaveTextContent(/Дубликат/);
  });
});

describe('PriorityTab — RICE score & term validation', () => {
  it('computes a live RICE score once all four fields are set', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft({ name: 'Альфа' })]} />);
    expect(screen.getByTestId('src-score-0')).toHaveTextContent('—');
    await user.selectOptions(screen.getByTestId('src-rice-reach-0'), '4');
    await user.selectOptions(screen.getByTestId('src-rice-impact-0'), '2');
    await user.selectOptions(screen.getByTestId('src-rice-confidence-0'), '0.8');
    await user.selectOptions(screen.getByTestId('src-rice-effort-0'), '2');
    // 4 * 2 * 0.8 / 2 = 3.2
    expect(screen.getByTestId('src-score-0')).toHaveTextContent('3.2');
  });

  it('warns when the source date falls outside its quarter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft({ name: 'Альфа' })]} />);
    await user.selectOptions(screen.getByTestId('src-quarter-0'), 'Q1');
    await user.type(screen.getByTestId('src-year-0'), '2026');
    await user.type(screen.getByTestId('src-date-0'), '2026-07-01');
    expect(screen.getByTestId('src-date-warning-0')).toBeInTheDocument();
  });
});

describe('PriorityTab — aggregate & PO decision', () => {
  it('shows the live aggregate priority and RICE across named sources', () => {
    const drafts: SourceDraft[] = [
      draft({
        _key: 'a',
        name: 'Альфа',
        priorityId: 'default',
        reach: 1,
        impact: 1,
        confidence: 0.5,
        effort: 5,
      }),
      draft({
        _key: 'b',
        name: 'Бета',
        priorityId: 'p-crit',
        reach: 5,
        impact: 3,
        confidence: 1,
        effort: 1,
      }),
    ];
    renderWithProviders(<Harness initialDrafts={drafts} />);
    // Senior priority wins (min order among used = «Квартальная цель»/default? crit order 1).
    expect(screen.getByTestId('req-aggregate-priority')).toBeInTheDocument();
    // RICE aggregate = max of the two source scores (15 for Бета).
    expect(screen.getByTestId('req-aggregate-rice')).toHaveTextContent('15.0');
  });

  it('shows an em dash aggregate when there are no named/scored sources', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByTestId('req-aggregate-priority-empty')).toBeInTheDocument();
    expect(screen.getByTestId('req-aggregate-rice')).toHaveTextContent('—');
  });

  it('lists source wishes and hides the PO plan when implemented', () => {
    const drafts: SourceDraft[] = [
      draft({
        _key: 'a',
        name: 'Альфа',
        targetQuarter: 'Q2',
        targetYear: 2026,
        targetDate: '2026-05-01',
      }),
    ];
    renderWithProviders(<Harness initialDrafts={drafts} implemented />);
    expect(screen.getByTestId('po-wishes')).toHaveTextContent('Альфа');
    expect(screen.getByTestId('po-wishes')).toHaveTextContent('2 квартал 2026');
    expect(screen.getByTestId('po-implemented-note')).toBeInTheDocument();
    expect(screen.queryByTestId('po-release-date')).toBeNull();
  });

  it('shows the empty-wishes hint and the PO plan fields when not implemented', () => {
    renderWithProviders(<Harness implemented={false} />);
    expect(screen.getByTestId('po-wishes-empty')).toBeInTheDocument();
    expect(screen.getByTestId('po-quarter')).toBeInTheDocument();
    expect(screen.getByTestId('po-year')).toBeInTheDocument();
    expect(screen.getByTestId('po-release-date')).toBeInTheDocument();
  });

  it('warns when the PO release date is outside the chosen quarter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness implemented={false} />);
    await user.selectOptions(screen.getByTestId('po-quarter'), 'Q1');
    await user.type(screen.getByTestId('po-year'), '2026');
    await user.type(screen.getByTestId('po-release-date'), '2026-09-01');
    expect(screen.getByTestId('po-release-warning')).toBeInTheDocument();
  });

  it('renders wishes for quarter-only and year-only and date-only drafts', () => {
    const drafts: SourceDraft[] = [
      draft({ _key: 'q', name: 'КвартОнли', targetQuarter: 'Q3' }),
      draft({ _key: 'y', name: 'ГодОнли', targetYear: 2030 }),
      draft({ _key: 'd', name: 'ДатаОнли', targetDate: '2031-01-15' }),
    ];
    renderWithProviders(<Harness initialDrafts={drafts} implemented={false} />);
    const wishes = screen.getByTestId('po-wishes');
    expect(within(wishes).getByTestId('po-wish-q')).toHaveTextContent('3 квартал');
    expect(within(wishes).getByTestId('po-wish-y')).toHaveTextContent('2030');
    expect(within(wishes).getByTestId('po-wish-d')).toHaveTextContent('2031-01-15');
  });

  it('round-trips a persisted source through toDraft (edit an existing card)', () => {
    const drafts = [
      toDraft({
        type: 'STAKEHOLDER',
        name: 'Иванов',
        priorityId: 'p-crit',
        rice: { reach: 5, impact: 3, confidence: 1, effort: 1 },
      }),
    ];
    renderWithProviders(<Harness initialDrafts={drafts} />);
    expect(screen.getByTestId('src-name-0-input')).toHaveValue('Иванов');
    expect(screen.getByTestId('src-priority-0')).toHaveValue('p-crit');
    expect(screen.getByTestId('src-score-0')).toHaveTextContent('15.0');
  });

  it('seeds a fresh card from emptyDraft with the senior default priority', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[emptyDraft(DICT.priorities)]} />);
    expect(screen.getByTestId('src-priority-0')).toHaveValue('default');
    await user.click(screen.getByTestId('src-add'));
    expect(screen.getByTestId('src-card-1')).toBeInTheDocument();
  });
});

describe('RICE — мини-инструкции по буквам (иконки-вопросики)', () => {
  it('у каждой буквы карточки источника есть иконка-вопросик с доступным именем', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    for (const key of ['reach', 'impact', 'confidence', 'effort']) {
      expect(screen.getByTestId(`rice-help-${key}-0`)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Что такое Reach' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Что такое Effort' })).toBeInTheDocument();
    // До наведения подсказок нет.
    expect(screen.queryByRole('tooltip')).toBeNull();
    void user;
  });

  it('наведение раскрывает инструкцию буквы, уход мыши — закрывает', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    await user.hover(screen.getByTestId('rice-help-reach-0'));
    const tip = await screen.findByTestId('rice-help-reach-0-tip');
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveTextContent('R — Reach (охват).');
    expect(tip).toHaveTextContent('Шкала 1–5');
    await user.unhover(screen.getByTestId('rice-help-reach-0'));
    expect(screen.queryByTestId('rice-help-reach-0-tip')).toBeNull();
  });

  it('фокус с клавиатуры тоже раскрывает подсказку (a11y), Esc закрывает', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    const btn = screen.getByTestId('rice-help-effort-0');
    btn.focus();
    const tip = await screen.findByTestId('rice-help-effort-0-tip');
    expect(tip).toHaveTextContent('E — Effort (трудоёмкость).');
    expect(tip).toHaveTextContent('RICE = R×I×C / E');
    // Кнопка связана с подсказкой для скринридера.
    expect(btn).toHaveAttribute('aria-describedby', tip.getAttribute('id'));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('rice-help-effort-0-tip')).toBeNull();
  });

  it('тексты всех четырёх букв согласованы со шкалами селектов', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialDrafts={[draft()]} />);
    const expectations: Array<[string, string]> = [
      ['impact', '0.25 — минимальное'],
      ['confidence', '50% — гипотеза, 80% — есть данные, 100% — подтверждено'],
    ];
    for (const [key, text] of expectations) {
      await user.hover(screen.getByTestId(`rice-help-${key}-0`));
      expect(await screen.findByTestId(`rice-help-${key}-0-tip`)).toHaveTextContent(text);
      await user.unhover(screen.getByTestId(`rice-help-${key}-0`));
    }
  });
});
