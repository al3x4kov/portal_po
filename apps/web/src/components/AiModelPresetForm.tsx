import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { RotateCcw } from 'lucide-react';
import {
  AI_MODEL_REASONING_MODES,
  aiModelPresetOverrideSchema,
  resolveModelPreset,
  type AiModelPresetOverride,
  type AiModelReasoning,
} from '@po/core';
import { useSaveAiConfig } from '../api/hooks';
import { errorMessage } from '../api/client';
import { BusyButton } from './BusyButton';

/**
 * todo_18 · «Параметры модели (best practices)». Per-model request/response
 * tuning: the user stores only OVERRIDES on top of the shipped defaults, and
 * the form always shows the EFFECTIVE preset ({@link resolveModelPreset}:
 * generic ← default-by-id ← override). Each field is flagged as user-overridden
 * or taken from the default so the source is never ambiguous.
 *
 * «Сохранить» sends `{ modelPresets: { [modelId]: <fields ≠ default> } }` (an
 * all-default form collapses to `{}` = reset); «Сбросить к дефолту» sends
 * `{ modelPresets: { [modelId]: {} } }` explicitly. Validation reuses
 * `aiModelPresetOverrideSchema` from `@po/core` — no duplicated rules.
 */

interface PresetFormValues {
  temperature: number;
  maxOutputTokens: number;
  chunkChars: number;
  reasoning: AiModelReasoning;
  topP?: number;
}

const REASONING_LABELS: Record<AiModelReasoning, string> = {
  none: 'Не трогать ответ (none)',
  strip: 'Вырезать рассуждения <think> (strip)',
};

/** Human names of the three AI features these presets influence. */
const FEATURE = {
  import: 'AI-генерация ФТ/НФТ по архиву',
  chat: 'виджет чата',
  desc: 'генерация описания в карточке ФТ/НФТ',
} as const;

/**
 * Plain-language «what is this / what does it affect» help under a field.
 * `param` yields a stable `ai-preset-help-<param>` testid for e2e; `impact`
 * spells out which product AI-features the parameter really touches (verified
 * against the server, not guessed).
 */
function FieldHelp({
  param,
  what,
  impact,
  hint,
}: {
  param: string;
  what: React.ReactNode;
  impact: React.ReactNode;
  hint?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mt-1 space-y-0.5" data-testid={`ai-preset-help-${param}`}>
      <p className="hint">{what}</p>
      <p className="hint">
        <span style={{ color: 'var(--color-text-2)' }}>Влияет на:</span> {impact}
      </p>
      {hint ? (
        <p className="hint" style={{ color: 'var(--color-text-3)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type Status = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null;

interface AiModelPresetFormProps {
  /** Available model ids (loaded list + the currently saved model). */
  models: string[];
  /** Stored per-model overrides (`config.modelPresets ?? {}`). */
  presets: Record<string, AiModelPresetOverride>;
  /** Model to preselect (the per-project model). */
  defaultModel: string;
}

/** Small «переопределено / по умолчанию» flag next to a field. */
function SourceBadge({ overridden }: { overridden: boolean }): React.ReactElement {
  return (
    <span
      className="badge text-[11px]"
      data-testid="badge"
      data-overridden={overridden ? 'true' : 'false'}
      style={
        overridden
          ? { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }
          : { background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }
      }
    >
      {overridden ? 'переопределено' : 'по умолчанию'}
    </span>
  );
}

export function AiModelPresetForm({
  models,
  presets,
  defaultModel,
}: AiModelPresetFormProps): React.ReactElement {
  const saveMut = useSaveAiConfig();
  const [modelId, setModelId] = useState<string>(defaultModel || models[0] || '');
  const [status, setStatus] = useState<Status>(null);

  // Preselect the project model once it (or the model list) arrives.
  useEffect(() => {
    if (!modelId && (defaultModel || models[0])) {
      setModelId(defaultModel || models[0]);
    }
  }, [modelId, defaultModel, models]);

  const override = presets[modelId];
  // Defaults for the picked model (no override) — the baseline for the badges.
  const defaults = useMemo(() => resolveModelPreset(modelId), [modelId]);
  // Effective preset actually applied: default ← override. Drives the inputs.
  const effective = useMemo<PresetFormValues>(
    () => resolveModelPreset(modelId, override),
    [modelId, override],
  );

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<AiModelPresetOverride>({
    resolver: zodResolver(aiModelPresetOverrideSchema),
    // `values` keeps the form in sync when the model (and thus effective) changes.
    values: effective,
  });

  const current = watch();

  async function persist(ov: AiModelPresetOverride, okText: string): Promise<void> {
    if (!modelId) return;
    setStatus(null);
    try {
      await saveMut.mutateAsync({ modelPresets: { [modelId]: ov } });
      setStatus({ kind: 'success', text: okText });
    } catch (err) {
      setStatus({ kind: 'error', text: `Не удалось сохранить: ${errorMessage(err)}` });
    }
  }

  const onSubmit = handleSubmit(async (v) => {
    // Store only what differs from the model default (all-default collapses to
    // `{}` = reset), so the badges and stored overrides stay honest.
    const ov: AiModelPresetOverride = {};
    if (v.temperature !== defaults.temperature) ov.temperature = v.temperature;
    if (v.maxOutputTokens !== defaults.maxOutputTokens) ov.maxOutputTokens = v.maxOutputTokens;
    if (v.chunkChars !== defaults.chunkChars) ov.chunkChars = v.chunkChars;
    if (v.reasoning !== defaults.reasoning) ov.reasoning = v.reasoning;
    if (typeof v.topP === 'number' && !Number.isNaN(v.topP) && v.topP !== defaults.topP) {
      ov.topP = v.topP;
    }
    await persist(ov, 'Параметры модели сохранены');
  });

  const onReset = (): void => {
    void persist({}, 'Параметры сброшены к дефолту');
  };

  if (models.length === 0 && !modelId) {
    return (
      <section className="card space-y-3 p-5" data-testid="ai-preset-section">
        <div>
          <h2 className="text-base font-bold">Параметры модели (best practices)</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
            Тонкая настройка запросов к модели: температура, лимиты токенов, размер чанка.
          </p>
        </div>
        <p
          className="rounded-lg p-3 text-sm"
          style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
          data-testid="ai-preset-empty"
        >
          Сначала подключите ключ и выберите модель — затем можно настроить её параметры.
        </p>
      </section>
    );
  }

  const overridden = {
    temperature: current.temperature !== defaults.temperature,
    maxOutputTokens: current.maxOutputTokens !== defaults.maxOutputTokens,
    chunkChars: current.chunkChars !== defaults.chunkChars,
    reasoning: current.reasoning !== defaults.reasoning,
    topP:
      typeof current.topP === 'number' &&
      !Number.isNaN(current.topP) &&
      current.topP !== defaults.topP,
  };

  return (
    <section className="card space-y-5 p-5" data-testid="ai-preset-section">
      <div>
        <h2 className="text-base font-bold">Параметры модели (best practices)</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
          Здесь настраивается поведение выбранной модели для AI-функций портала: «AI-генерация
          ФТ/НФТ по архиву» (импорт), «виджет чата» и «генерация описания в карточке ФТ/НФТ». У
          каждого параметра ниже указано, что он делает простыми словами и на какие функции влияет.
        </p>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
          Значения по умолчанию подобраны под каждую модель. Показаны эффективные значения — то, что
          реально применится (дефолт модели + ваши переопределения).
        </p>
      </div>

      <div>
        <label className="label" htmlFor="ai-preset-model">
          Модель
        </label>
        <select
          id="ai-preset-model"
          className="input"
          data-testid="ai-preset-model-select"
          value={modelId}
          onChange={(e) => {
            setStatus(null);
            setModelId(e.target.value);
          }}
        >
          {models.length === 0 && modelId ? <option value={modelId}>{modelId}</option> : null}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* temperature */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="ai-preset-temperature">
                Температура
              </label>
              <SourceBadge overridden={overridden.temperature} />
            </div>
            <input
              id="ai-preset-temperature"
              className="input mt-1"
              type="number"
              step="0.1"
              min="0"
              max="2"
              data-testid="ai-preset-temperature"
              {...register('temperature', { valueAsNumber: true })}
            />
            <FieldHelp
              param="temperature"
              what="Насколько «творчески» и вариативно отвечает модель. Ниже — точнее и стабильнее, выше — разнообразнее (0–2)."
              impact={
                <>
                  только «{FEATURE.import}». Чат и генерация описания используют свои встроенные
                  настройки и этот параметр их не меняет.
                </>
              }
            />
            {errors.temperature ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--color-danger-fg)' }} role="alert">
                Значение должно быть числом от 0 до 2.
              </p>
            ) : null}
          </div>

          {/* topP */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="ai-preset-topP">
                top_p (необязательно)
              </label>
              <SourceBadge overridden={overridden.topP} />
            </div>
            <input
              id="ai-preset-topP"
              className="input mt-1"
              type="number"
              step="0.05"
              min="0"
              max="1"
              placeholder="не задано"
              data-testid="ai-preset-topP"
              {...register('topP', {
                setValueAs: (v) =>
                  v === '' || v === null || v === undefined ? undefined : Number(v),
              })}
            />
            <FieldHelp
              param="topP"
              what="Альтернатива температуре: ограничивает выбор слов по суммарной вероятности (0–1). Обычно оставляют пустым — тогда параметр не передаётся."
              impact={<>все AI-функции (импорт, чат, генерация описания), если значение задано.</>}
            />
            {errors.topP ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--color-danger-fg)' }} role="alert">
                Значение должно быть числом от 0 до 1.
              </p>
            ) : null}
          </div>

          {/* maxOutputTokens */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="ai-preset-maxOutputTokens">
                Лимит выходных токенов
              </label>
              <SourceBadge overridden={overridden.maxOutputTokens} />
            </div>
            <input
              id="ai-preset-maxOutputTokens"
              className="input mt-1"
              type="number"
              step="1"
              min="1"
              data-testid="ai-preset-maxOutputTokens"
              {...register('maxOutputTokens', { valueAsNumber: true })}
            />
            <FieldHelp
              param="maxOutputTokens"
              what="Максимум токенов в одном ответе модели, включая «размышления» reasoning-моделей. Если мало — ответ обрежется (в логе импорта «ответ обрезан по лимиту токенов»). Целое ≥ 1."
              impact={
                <>
                  прежде всего «{FEATURE.import}» — здесь это полный бюджет ответа (его повышают,
                  когда ответ обрезается). Для чата и генерации описания — только верхняя граница, у
                  них свой небольшой бюджет.
                </>
              }
            />
            {errors.maxOutputTokens ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--color-danger-fg)' }} role="alert">
                Введите целое число ≥ 1.
              </p>
            ) : null}
          </div>

          {/* chunkChars */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="ai-preset-chunkChars">
                Размер чанка (символов)
              </label>
              <SourceBadge overridden={overridden.chunkChars} />
            </div>
            <input
              id="ai-preset-chunkChars"
              className="input mt-1"
              type="number"
              step="1000"
              min="1000"
              data-testid="ai-preset-chunkChars"
              {...register('chunkChars', { valueAsNumber: true })}
            />
            <FieldHelp
              param="chunkChars"
              what="Сколько символов документации отправляется за один запрос при разборе архива. Меньше — короче ответы и надёжнее, но больше запросов. Целое ≥ 1000."
              impact={<>только «{FEATURE.import}».</>}
            />
            {errors.chunkChars ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--color-danger-fg)' }} role="alert">
                Введите целое число ≥ 1000.
              </p>
            ) : null}
          </div>

          {/* reasoning */}
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="ai-preset-reasoning">
                Рассуждения модели
              </label>
              <SourceBadge overridden={overridden.reasoning} />
            </div>
            <select
              id="ai-preset-reasoning"
              className="input mt-1"
              data-testid="ai-preset-reasoning"
              {...register('reasoning')}
            >
              {AI_MODEL_REASONING_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {REASONING_LABELS[mode]}
                </option>
              ))}
            </select>
            <FieldHelp
              param="reasoning"
              what={
                <>
                  Как обрабатывать «думающие» модели: «strip» вырезает блок{' '}
                  <code>&lt;think&gt;…&lt;/think&gt;</code> из ответа; «none» — не трогает (для
                  обычных моделей вроде Coder-Next).
                </>
              }
              impact={<>все AI-функции: импорт, чат и генерация описания.</>}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <BusyButton
            type="submit"
            className="btn btn-primary text-sm"
            busy={saveMut.isPending}
            busyLabel="Сохраняем…"
            data-testid="ai-preset-save"
          >
            Сохранить
          </BusyButton>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="ai-preset-reset"
            disabled={saveMut.isPending}
            onClick={onReset}
          >
            <RotateCcw className="icon-sm" aria-hidden="true" />
            Сбросить к дефолту
          </button>
          {status ? (
            <span
              className="text-sm"
              role="status"
              data-testid="ai-preset-status"
              style={{
                color:
                  status.kind === 'success' ? 'var(--color-success-fg)' : 'var(--color-danger-fg)',
              }}
            >
              {status.text}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
