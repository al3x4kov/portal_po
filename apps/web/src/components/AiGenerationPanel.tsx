import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Criticality, GenerateDescriptionRequest, RequirementType } from '@po/core';
import { useAiConfig, useGenerateDescription } from '../api/hooks';
import { errorMessage } from '../api/client';

interface AiGenerationPanelProps {
  projectId: string;
  requirementName: string;
  requirementType: RequirementType;
  criticality?: Criticality;
  currentDescription: string;
  projectName?: string;
  projectDescription?: string;
  /**
   * Called with the generated text and the chosen merge mode (§2.10: two
   * explicit buttons instead of a silent overwrite): 'replace' substitutes the
   * current description, 'append' adds the text to its end.
   */
  onApply: (generated: string, mode: 'replace' | 'append') => void;
}

/**
 * T-803: inline «AI Hub generation» panel attached to the description field.
 * States mirror the mockup (`generation.html`): collapsed → hint → loading →
 * preview (cancel/regenerate/apply) → error → not-configured (disabled + link).
 * The key never leaves the server; readiness is derived from `hasApiKey` + model.
 */
export function AiGenerationPanel({
  projectId,
  requirementName,
  requirementType,
  criticality,
  currentDescription,
  projectName,
  projectDescription,
  onApply,
}: AiGenerationPanelProps): React.ReactElement {
  const configQuery = useAiConfig(projectId);
  const genMut = useGenerateDescription();

  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config = configQuery.data;
  const configReady = Boolean(config?.hasApiKey && config?.model);
  const contextReady = requirementName.trim().length > 0 && Boolean(criticality);

  const reset = (): void => {
    setOpen(false);
    setHint('');
    setPreview(null);
    setError(null);
  };

  const runGenerate = async (): Promise<void> => {
    if (!criticality || requirementName.trim().length === 0) return;
    setError(null);
    const body: GenerateDescriptionRequest = {
      projectId,
      requirement: {
        name: requirementName.trim(),
        type: requirementType,
        criticality,
        description: currentDescription.trim().length > 0 ? currentDescription : undefined,
      },
      ...(projectName ? { projectName } : {}),
      ...(projectDescription ? { projectDescription } : {}),
      ...(hint.trim().length > 0 ? { userHint: hint.trim() } : {}),
    };
    try {
      const res = await genMut.mutateAsync(body);
      setPreview(res.description);
    } catch (err) {
      setPreview(null);
      setError(errorMessage(err));
    }
  };

  const loading = genMut.isPending;

  // ── State 6: not configured ───────────────────────────────────────────────
  if (!configReady) {
    return (
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="btn btn-secondary text-xs"
          data-testid="ai-gen-open"
          disabled
          style={{ opacity: 0.5 }}
          title="Нужен API-ключ и модель"
        >
          ✨ AI Hub generation
        </button>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          Нужен API-ключ и модель —{' '}
          <Link
            to={`/p/${projectId}/ai`}
            className="underline"
            style={{ color: 'var(--color-primary)' }}
            data-testid="ai-gen-setup-link"
          >
            Настройте AI Hub
          </Link>
        </span>
      </div>
    );
  }

  // ── State 1: collapsed ────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="mt-2">
        <button
          type="button"
          className="btn btn-secondary text-xs"
          data-testid="ai-gen-open"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          ✨ AI Hub generation
        </button>
        {error ? (
          <p
            className="mt-2 rounded-lg p-3 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            data-testid="ai-gen-error"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {loading ? (
        // ── State 3: loading ────────────────────────────────────────────────
        <div
          className="rounded-lg p-4 text-center text-sm"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}
          data-testid="ai-gen-loading"
        >
          ⟳ AI Hub формирует описание…
        </div>
      ) : preview !== null ? (
        // ── State 4: preview ────────────────────────────────────────────────
        <div className="rounded-lg p-3" style={{ background: 'var(--color-primary-soft)' }}>
          <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Предпросмотр{config?.model ? ` (модель ${config.model})` : ''}
          </p>
          <div
            className="rounded-lg border p-3 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
            data-testid="ai-gen-preview"
          >
            {preview}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary text-xs"
              data-testid="ai-gen-cancel"
              onClick={reset}
            >
              Отменить
            </button>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              data-testid="ai-gen-regen"
              onClick={() => void runGenerate()}
            >
              ↻ Сгенерировать заново
            </button>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              data-testid="ai-gen-append"
              onClick={() => {
                onApply(preview, 'append');
                reset();
              }}
            >
              Дополнить
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              data-testid="ai-gen-apply"
              onClick={() => {
                onApply(preview, 'replace');
                reset();
              }}
            >
              Заменить описание
            </button>
          </div>
          <p className="hint mt-1.5 text-right">
            «Дополнить» добавит текст в конец текущего описания
          </p>
        </div>
      ) : (
        // ── State 2: hint input ─────────────────────────────────────────────
        <div className="rounded-lg p-3" style={{ background: 'var(--color-surface-2)' }}>
          <label
            className="mb-1 block text-[13px] font-semibold"
            style={{ color: 'var(--color-text-2)' }}
            htmlFor="ai-gen-hint"
          >
            Уточняющая подсказка (необязательно)
          </label>
          <textarea
            id="ai-gen-hint"
            className="input"
            rows={3}
            style={{ resize: 'vertical' }}
            placeholder="Напр.: сделать акцент на валидации и сообщениях об ошибках"
            value={hint}
            data-testid="ai-gen-hint"
            onChange={(e) => setHint(e.target.value)}
          />
          {!contextReady ? (
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
              Укажите название и критичность требования, чтобы сгенерировать описание.
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary text-xs"
              data-testid="ai-gen-cancel"
              onClick={reset}
            >
              Отменить
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              data-testid="ai-gen-submit"
              disabled={!contextReady}
              onClick={() => void runGenerate()}
            >
              ✨ Сгенерировать
            </button>
          </div>
        </div>
      )}

      {error ? (
        <p
          className="mt-2 rounded-lg p-3 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="ai-gen-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
