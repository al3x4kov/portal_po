import { useMemo } from 'react';
import { isEmbeddingModelId } from '@po/core';

/**
 * Shared rendering of the model list inside every model <select> (AI page,
 * AI-import modal, backlog-import modal, preset form). Embedding models are
 * not usable for generation (the server rejects them with 400), so they are
 * moved out of the main list into a disabled <optgroup> at the end — visible,
 * but not selectable. A previously saved embedding model still displays as
 * the current value (browsers allow a programmatic value on a disabled
 * option); the accompanying warning explains why it will not work.
 */

export const EMBEDDING_GROUP_LABEL = 'Embedding-модели (не для генерации)';

export const EMBEDDING_WARNING_TEXT =
  'Выбрана embedding-модель — импорт не запустится. Выберите чат-модель.';

/** Split a model-id list into selectable chat models and embedding models. */
export function splitModelOptions(models: readonly string[]): {
  chat: string[];
  embedding: string[];
} {
  const chat: string[] = [];
  const embedding: string[] = [];
  for (const m of models) (isEmbeddingModelId(m) ? embedding : chat).push(m);
  return { chat, embedding };
}

/** First model usable for generation (skips embedding models). */
export function firstChatModel(models: readonly string[]): string | undefined {
  return models.find((m) => !isEmbeddingModelId(m));
}

export interface ModelSelectOptionsProps {
  /** Model ids to render (already includes the currently selected one). */
  models: readonly string[];
  /** data-testid for the disabled embedding <optgroup>. */
  embeddingGroupTestid?: string;
}

/**
 * <option> list for a model <select>: chat models first, then a disabled
 * «Embedding-модели (не для генерации)» group. Render inside a <select>.
 */
export function ModelSelectOptions({
  models,
  embeddingGroupTestid,
}: ModelSelectOptionsProps): React.ReactElement {
  const { chat, embedding } = useMemo(() => splitModelOptions(models), [models]);
  return (
    <>
      {chat.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {embedding.length > 0 ? (
        <optgroup disabled label={EMBEDDING_GROUP_LABEL} data-testid={embeddingGroupTestid}>
          {embedding.map((m) => (
            <option key={m} value={m} disabled>
              {m}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

export interface EmbeddingModelWarningProps {
  /** Currently selected model id ('' — nothing selected). */
  model: string;
  /** data-testid, e.g. `ai-import-embedding-warning`. */
  testid: string;
  className?: string;
}

/**
 * Inline warning under a model select when a stored/selected model is an
 * embedding one (a config saved before the guard could contain it).
 */
export function EmbeddingModelWarning({
  model,
  testid,
  className = 'mt-1 text-xs',
}: EmbeddingModelWarningProps): React.ReactElement | null {
  if (!model || !isEmbeddingModelId(model)) return null;
  return (
    <p
      className={className}
      role="alert"
      style={{ color: 'var(--color-warning-fg)' }}
      data-testid={testid}
    >
      {EMBEDDING_WARNING_TEXT}
    </p>
  );
}
