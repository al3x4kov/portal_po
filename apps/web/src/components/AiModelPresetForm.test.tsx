import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiModelPresetOverride } from '@po/core';
import { AiModelPresetForm } from './AiModelPresetForm';
import { renderWithProviders } from '../test/utils';

const saveConfig = vi.fn();

vi.mock('../api/endpoints', () => ({
  aiApi: {
    saveConfig: (...a: unknown[]) => saveConfig(...a),
  },
}));

// defaults (temperature / maxOutputTokens / chunkChars / reasoning) come from
// @po/core AI_MODEL_PRESET_DEFAULTS — kept in sync via resolveModelPreset below.
const CODER = 'Qwen/Qwen3-Coder-Next'; // 0.2 / 4000 / 12000 / none
const SMALL = 'Qwen/Qwen3.6-27B'; // 0.2 / 12000 / 16000 / strip
const MODELS = [CODER, SMALL];

function renderForm(
  presets: Record<string, AiModelPresetOverride> = {},
  defaultModel = CODER,
): void {
  renderWithProviders(
    <AiModelPresetForm models={MODELS} presets={presets} defaultModel={defaultModel} />,
  );
}

/** The «переопределено / по умолчанию» flag rendered next to a field. */
function badgeOverridden(fieldTestId: string): boolean {
  const field = screen.getByTestId(fieldTestId);
  // The input's closest <div> is its field group; the badge lives in the
  // label row inside that same group.
  const group = field.closest('div') as HTMLElement;
  const badge = within(group).getByTestId('badge');
  return badge.getAttribute('data-overridden') === 'true';
}

describe('AiModelPresetForm (todo_18)', () => {
  beforeEach(() => {
    saveConfig.mockReset().mockResolvedValue({ baseURL: '', hasApiKey: true });
  });

  it('shows the effective preset (default-by-id) and «по умолчанию» flags with no override', () => {
    renderForm();
    expect(screen.getByTestId('ai-preset-temperature')).toHaveValue(0.2);
    expect(screen.getByTestId('ai-preset-maxOutputTokens')).toHaveValue(4000);
    expect(screen.getByTestId('ai-preset-chunkChars')).toHaveValue(12000);
    expect(screen.getByTestId('ai-preset-reasoning')).toHaveValue('none');
    expect(screen.getByTestId('ai-preset-topP')).toHaveValue(null);

    expect(badgeOverridden('ai-preset-temperature')).toBe(false);
    expect(badgeOverridden('ai-preset-maxOutputTokens')).toBe(false);
    expect(badgeOverridden('ai-preset-reasoning')).toBe(false);
  });

  it('resolveModelPreset: an override wins over the default and is flagged «переопределено»', () => {
    renderForm({ [CODER]: { temperature: 0.9 } });
    // 0.9 (override) on top of the model default; other fields stay default.
    expect(screen.getByTestId('ai-preset-temperature')).toHaveValue(0.9);
    expect(badgeOverridden('ai-preset-temperature')).toBe(true);
    expect(badgeOverridden('ai-preset-maxOutputTokens')).toBe(false);
  });

  it('switching the model reloads that model’s effective preset', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(screen.getByTestId('ai-preset-model-select'), SMALL);
    expect(screen.getByTestId('ai-preset-chunkChars')).toHaveValue(16000);
    expect(screen.getByTestId('ai-preset-reasoning')).toHaveValue('strip');
  });

  it('«Сохранить» sends only the fields that differ from the model default', async () => {
    const user = userEvent.setup();
    renderForm();

    const temp = screen.getByTestId('ai-preset-temperature');
    await user.clear(temp);
    await user.type(temp, '0.7');
    const topP = screen.getByTestId('ai-preset-topP');
    await user.type(topP, '0.85');

    await user.click(screen.getByTestId('ai-preset-save'));

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({
        modelPresets: { [CODER]: { temperature: 0.7, topP: 0.85 } },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('ai-preset-status')).toHaveTextContent('сохранены'),
    );
  });

  it('«Сохранить» collapses an all-default form to an empty override', async () => {
    // Effective already equals the defaults → nothing differs → {}.
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByTestId('ai-preset-save'));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith({ modelPresets: { [CODER]: {} } }));
  });

  it('«Сбросить к дефолту» sends an explicit empty override for the model', async () => {
    const user = userEvent.setup();
    renderForm({ [CODER]: { temperature: 1.5 } });
    await user.click(screen.getByTestId('ai-preset-reset'));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith({ modelPresets: { [CODER]: {} } }));
    await waitFor(() =>
      expect(screen.getByTestId('ai-preset-status')).toHaveTextContent('сброшены'),
    );
  });

  it('validation from @po/core blocks the save on an out-of-range value', async () => {
    const user = userEvent.setup();
    renderForm();
    const temp = screen.getByTestId('ai-preset-temperature');
    await user.clear(temp);
    await user.type(temp, '3'); // temperature max is 2 in aiModelPresetSchema

    await user.click(screen.getByTestId('ai-preset-save'));

    expect(await screen.findByText(/от 0 до 2/)).toBeInTheDocument();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('explains every parameter in plain language and tags which AI-feature it affects', () => {
    renderForm();

    // Intro names all three AI-features these presets influence.
    const section = screen.getByTestId('ai-preset-section');
    expect(section).toHaveTextContent(/AI-генерация ФТ\/НФТ по архиву/);
    expect(section).toHaveTextContent(/виджет чата/);
    expect(section).toHaveTextContent(/генерация описания в карточке/);

    // Each parameter has a plain-language help block with an «Влияет на:» tag.
    for (const param of [
      'temperature',
      'topP',
      'maxOutputTokens',
      'chunkChars',
      'reasoning',
    ] as const) {
      const help = screen.getByTestId(`ai-preset-help-${param}`);
      expect(help).toHaveTextContent(/Влияет на:/);
    }

    // Impact map is truthful: temperature/chunkChars are import-only; reasoning
    // hits all three features.
    expect(screen.getByTestId('ai-preset-help-temperature')).toHaveTextContent(
      /только «AI-генерация ФТ\/НФТ по архиву»/,
    );
    expect(screen.getByTestId('ai-preset-help-chunkChars')).toHaveTextContent(
      /только «AI-генерация ФТ\/НФТ по архиву»/,
    );
    expect(screen.getByTestId('ai-preset-help-reasoning')).toHaveTextContent(/все AI-функции/);
    expect(screen.getByTestId('ai-preset-help-maxOutputTokens')).toHaveTextContent(
      /полный бюджет ответа/,
    );
  });

  it('renders an empty-state hint when there is no model to configure yet', () => {
    renderWithProviders(<AiModelPresetForm models={[]} presets={{}} defaultModel="" />);
    expect(screen.getByTestId('ai-preset-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-preset-save')).not.toBeInTheDocument();
  });

  // ── todo_20 T-215: run-control fields of the import pipeline ───────────────

  describe('run-control fields (todo_20)', () => {
    it('shows the shipped defaults: parallelism 2, timeout 120, budget/threshold per contract', () => {
      renderForm();
      expect(screen.getByTestId('ai-preset-parallelism')).toHaveValue(2);
      expect(screen.getByTestId('ai-preset-perCallTimeoutSec')).toHaveValue(120);
      // runBudgetTokens default is null → empty input («без лимита»).
      expect(screen.getByTestId('ai-preset-runBudgetTokens')).toHaveValue(null);
      expect(screen.getByTestId('ai-preset-estimateThresholdTokens')).toHaveValue(2_000_000);

      expect(badgeOverridden('ai-preset-parallelism')).toBe(false);
      expect(badgeOverridden('ai-preset-perCallTimeoutSec')).toBe(false);
      expect(badgeOverridden('ai-preset-runBudgetTokens')).toBe(false);
      expect(badgeOverridden('ai-preset-estimateThresholdTokens')).toBe(false);
    });

    it('explains each run-control field and scopes the impact to the import', () => {
      renderForm();
      for (const param of [
        'parallelism',
        'perCallTimeoutSec',
        'runBudgetTokens',
        'estimateThresholdTokens',
      ] as const) {
        const help = screen.getByTestId(`ai-preset-help-${param}`);
        expect(help).toHaveTextContent(/Влияет на:/);
        expect(help).toHaveTextContent(/только «AI-генерация ФТ\/НФТ по архиву»/);
      }
      // The threshold semantics (0 / empty) are spelled out (PO decision №2).
      expect(screen.getByTestId('ai-preset-help-estimateThresholdTokens')).toHaveTextContent(
        '0 — подтверждать всегда; пусто — никогда не спрашивать.',
      );
    });

    it('saves only the changed run-control fields as an override', async () => {
      const user = userEvent.setup();
      renderForm();

      const par = screen.getByTestId('ai-preset-parallelism');
      await user.clear(par);
      await user.type(par, '4');
      const budget = screen.getByTestId('ai-preset-runBudgetTokens');
      await user.type(budget, '10000000');

      await user.click(screen.getByTestId('ai-preset-save'));
      await waitFor(() =>
        expect(saveConfig).toHaveBeenCalledWith({
          modelPresets: { [CODER]: { parallelism: 4, runBudgetTokens: 10_000_000 } },
        }),
      );
    });

    it('clearing the estimate threshold stores an explicit null («не спрашивать»)', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.clear(screen.getByTestId('ai-preset-estimateThresholdTokens'));
      await user.click(screen.getByTestId('ai-preset-save'));

      await waitFor(() =>
        expect(saveConfig).toHaveBeenCalledWith({
          modelPresets: { [CODER]: { estimateThresholdTokens: null } },
        }),
      );
    });

    it('stored overrides render as effective values with the «переопределено» flag', () => {
      renderForm({ [CODER]: { parallelism: 8, perCallTimeoutSec: 300 } });
      expect(screen.getByTestId('ai-preset-parallelism')).toHaveValue(8);
      expect(screen.getByTestId('ai-preset-perCallTimeoutSec')).toHaveValue(300);
      expect(badgeOverridden('ai-preset-parallelism')).toBe(true);
      expect(badgeOverridden('ai-preset-perCallTimeoutSec')).toBe(true);
      expect(badgeOverridden('ai-preset-runBudgetTokens')).toBe(false);
    });

    it('validation from @po/core blocks an out-of-range parallelism', async () => {
      const user = userEvent.setup();
      renderForm();
      const par = screen.getByTestId('ai-preset-parallelism');
      await user.clear(par);
      await user.type(par, '9'); // max is 8 in aiModelPresetSchema

      await user.click(screen.getByTestId('ai-preset-save'));

      expect(await screen.findByText(/от 1 до 8/)).toBeInTheDocument();
      expect(saveConfig).not.toHaveBeenCalled();
    });
  });
});
