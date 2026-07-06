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

const CODER = 'Qwen/Qwen3-Coder-Next'; // defaults: 0.2 / 4000 / 12000 / none
const SMALL = 'Qwen/Qwen3.6-27B'; // defaults: 0.2 / 6000 / 16000 / strip
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

  it('renders an empty-state hint when there is no model to configure yet', () => {
    renderWithProviders(<AiModelPresetForm models={[]} presets={{}} defaultModel="" />);
    expect(screen.getByTestId('ai-preset-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-preset-save')).not.toBeInTheDocument();
  });
});
