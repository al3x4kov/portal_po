import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EMBEDDING_GROUP_LABEL,
  EMBEDDING_WARNING_TEXT,
  EmbeddingModelWarning,
  ModelSelectOptions,
  firstChatModel,
  splitModelOptions,
} from './ModelSelectOptions';

/** Real model list from the user's hub: half of it is embedding models. */
const HUB_MODELS = [
  'BAAI/bge-m3',
  'DeepSeek-V3',
  'Embeddings',
  'Embeddings-2',
  'EmbeddingsGigaR',
  'GigaChat-2-Pro',
  'GigaEmbeddings-3B-2025-09',
  'Qodo/Qodo-Embed-1-1.5B',
  'Qwen/Qwen3-VL-Embedding-8B',
  'Qwen/Qwen3-235B',
];

const CHAT_MODELS = ['DeepSeek-V3', 'GigaChat-2-Pro', 'Qwen/Qwen3-235B'];
const EMBEDDING_MODELS = HUB_MODELS.filter((m) => !CHAT_MODELS.includes(m));

/** Controlled select harness mirroring how the app renders model selects. */
function Harness({ initial = '' }: { initial?: string }): React.ReactElement {
  const [model, setModel] = useState(initial);
  return (
    <>
      <label htmlFor="m">Модель</label>
      <select
        id="m"
        data-testid="model-select"
        value={model}
        onChange={(e) => setModel(e.target.value)}
      >
        {model.length === 0 ? <option value="">— выберите модель —</option> : null}
        <ModelSelectOptions models={HUB_MODELS} embeddingGroupTestid="embedding-group" />
      </select>
      <EmbeddingModelWarning model={model} testid="embedding-warning" />
    </>
  );
}

describe('splitModelOptions / firstChatModel', () => {
  it('отделяет embedding-модели от чат-моделей', () => {
    const { chat, embedding } = splitModelOptions(HUB_MODELS);
    expect(chat).toEqual(CHAT_MODELS);
    expect(embedding).toEqual(EMBEDDING_MODELS);
  });

  it('firstChatModel пропускает embedding-модели', () => {
    expect(firstChatModel(HUB_MODELS)).toBe('DeepSeek-V3');
    expect(firstChatModel(['Embeddings', 'BAAI/bge-m3'])).toBeUndefined();
  });
});

describe('ModelSelectOptions', () => {
  it('embedding-модели вынесены в disabled-группу и невыбираемы', () => {
    render(<Harness />);
    const group = screen.getByTestId('embedding-group');
    expect(group).toBeDisabled();
    expect(group).toHaveAttribute('label', EMBEDDING_GROUP_LABEL);
    for (const m of EMBEDDING_MODELS) {
      const opt = screen.getByRole('option', { name: m }) as HTMLOptionElement;
      expect(opt.disabled).toBe(true);
      expect(group.contains(opt)).toBe(true);
    }
  });

  it('чат-модели остаются в основном списке и выбираемы', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    for (const m of CHAT_MODELS) {
      const opt = screen.getByRole('option', { name: m }) as HTMLOptionElement;
      expect(opt.disabled).toBe(false);
    }
    await user.selectOptions(select, 'GigaChat-2-Pro');
    expect(select.value).toBe('GigaChat-2-Pro');
    expect(screen.queryByTestId('embedding-warning')).not.toBeInTheDocument();
  });

  it('не рендерит группу, когда embedding-моделей нет', () => {
    render(
      <select data-testid="s">
        <ModelSelectOptions models={CHAT_MODELS} embeddingGroupTestid="embedding-group" />
      </select>,
    );
    expect(screen.queryByTestId('embedding-group')).not.toBeInTheDocument();
  });
});

describe('EmbeddingModelWarning', () => {
  it('сохранённая embedding-модель отображается выбранной и с предупреждением', () => {
    render(<Harness initial="EmbeddingsGigaR" />);
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(select.value).toBe('EmbeddingsGigaR');
    const warning = screen.getByTestId('embedding-warning');
    expect(warning).toHaveTextContent(EMBEDDING_WARNING_TEXT);
    expect(warning).toHaveAttribute('role', 'alert');
  });

  it('нет предупреждения для чат-модели и пустого выбора', () => {
    const { rerender } = render(<EmbeddingModelWarning model="GigaChat-2-Pro" testid="w" />);
    expect(screen.queryByTestId('w')).not.toBeInTheDocument();
    rerender(<EmbeddingModelWarning model="" testid="w" />);
    expect(screen.queryByTestId('w')).not.toBeInTheDocument();
  });
});
