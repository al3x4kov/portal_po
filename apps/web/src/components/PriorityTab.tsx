import { useState } from 'react';
import { Plus, TriangleAlert, X } from 'lucide-react';
import {
  aggregatePriorityId,
  aggregateRiceScore,
  isDateInQuarter,
  TARGET_QUARTERS,
  type PriorityColor,
  type ProjectDictionaries,
  type SourcePriority,
  type SourceRef,
  type SourceType,
  type TargetQuarter,
} from '@po/core';
import { useAddPriority, useAddSource } from '../api/hooks';
import { errorMessage } from '../api/client';
import {
  CONFIDENCE_OPTIONS,
  EFFORT_OPTIONS,
  IMPACT_OPTIONS,
  REACH_OPTIONS,
  draftScore,
  draftsForAggregate,
  emptyDraft,
  type SourceDraft,
} from '../lib/sourceDraft';
import { SOURCE_TYPE_ICON, SOURCE_TYPE_LABEL, SOURCE_TYPES_ORDER } from '../lib/sourceTypes';
import { PriorityBadge } from './PriorityBadge';
import { ColorPalettePicker } from './ColorPalettePicker';
import { SourceCombobox } from './SourceCombobox';

interface PriorityTabProps {
  projectId: string;
  dictionaries: ProjectDictionaries;
  drafts: SourceDraft[];
  onChange: (drafts: SourceDraft[]) => void;
  /** Requirement-level plan (shared with «Основное»); cleared when implemented. */
  implemented: boolean | undefined;
  targetQuarter: TargetQuarter | undefined;
  targetYear: number | undefined;
  onTargetQuarter: (q: TargetQuarter | undefined) => void;
  onTargetYear: (y: number | undefined) => void;
  /** PO release date (todo_19 D2); hidden when implemented === true. */
  releaseDate: string;
  onReleaseDate: (v: string) => void;
}

function priorityById(
  priorities: readonly SourcePriority[],
  id: string,
): SourcePriority | undefined {
  return priorities.find((p) => p.id === id);
}

/** Quarter label as in the mockup («3 квартал»). */
function quarterLabel(q: TargetQuarter): string {
  return `${q.replace('Q', '')} квартал`;
}

export function PriorityTab({
  projectId,
  dictionaries,
  drafts,
  onChange,
  implemented,
  targetQuarter,
  targetYear,
  onTargetQuarter,
  onTargetYear,
  releaseDate,
  onReleaseDate,
}: PriorityTabProps): React.ReactElement {
  const priorities = [...dictionaries.priorities].sort((a, b) => a.order - b.order);
  const addSourceMut = useAddSource(projectId);
  const addPriorityMut = useAddPriority(projectId);
  const [dictError, setDictError] = useState<string | null>(null);

  // Inline «add priority» form, scoped to a single card (_key) at a time.
  const [addPrioFor, setAddPrioFor] = useState<string | null>(null);
  const [newPrioName, setNewPrioName] = useState('');
  const [newPrioColor, setNewPrioColor] = useState<PriorityColor>('blue');

  const patch = (key: string, update: Partial<SourceDraft>): void => {
    onChange(drafts.map((d) => (d._key === key ? { ...d, ...update } : d)));
  };

  const addSourceCard = (): void => {
    onChange([...drafts, emptyDraft(priorities)]);
  };

  const removeCard = (key: string): void => {
    onChange(drafts.filter((d) => d._key !== key));
  };

  // ФТ-C2.1: creating a new source name auto-collects it into the dictionary.
  const createSource = async (key: string, name: string, type: SourceType): Promise<void> => {
    patch(key, { name });
    setDictError(null);
    try {
      const ref = await addSourceMut.mutateAsync({ name, type });
      patch(key, { name: ref.name, type: ref.type });
    } catch (err) {
      setDictError(errorMessage(err));
    }
  };

  const submitNewPriority = async (key: string): Promise<void> => {
    const name = newPrioName.trim();
    if (name.length === 0) return;
    setDictError(null);
    try {
      const created = await addPriorityMut.mutateAsync({ name, color: newPrioColor });
      patch(key, { priorityId: created.id });
      setAddPrioFor(null);
      setNewPrioName('');
      setNewPrioColor('blue');
    } catch (err) {
      setDictError(errorMessage(err));
    }
  };

  // Live aggregate (todo_19 T-206 / ФТ-B2): priority = most senior, RICE = max.
  const aggregateSources = draftsForAggregate(drafts);
  const aggPriorityId = aggregatePriorityId(aggregateSources, priorities);
  const aggPriority = aggPriorityId ? priorityById(priorities, aggPriorityId) : undefined;
  const aggRice = aggregateRiceScore(aggregateSources);

  // Source wishes summary for the PO decision block (ФТ-D2).
  const wishes = drafts
    .filter((d) => d.name.trim().length > 0 && (d.targetQuarter || d.targetYear || d.targetDate))
    .map((d) => {
      const parts: string[] = [];
      if (d.targetQuarter && d.targetYear)
        parts.push(`${quarterLabel(d.targetQuarter)} ${d.targetYear}`);
      else if (d.targetQuarter) parts.push(quarterLabel(d.targetQuarter));
      else if (d.targetYear) parts.push(String(d.targetYear));
      if (d.targetDate) parts.push(`к ${d.targetDate}`);
      return { key: d._key, name: d.name.trim(), text: parts.join(', ') };
    });

  const releaseOutOfQuarter =
    releaseDate.length > 0 &&
    targetQuarter != null &&
    targetYear != null &&
    !isDateInQuarter(releaseDate, targetQuarter, targetYear);

  return (
    <div className="space-y-4" data-testid="req-priority-tab">
      {dictError ? (
        <p
          className="rounded-md px-3 py-2 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="req-priority-dict-error"
        >
          {dictError}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">
          Источники требования{' '}
          <span className="t3 font-normal">— у каждого свой приоритет и оценка</span>
        </h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="src-add"
          onClick={addSourceCard}
        >
          <Plus className="icon-sm" aria-hidden="true" /> Добавить источник
        </button>
      </div>

      {drafts.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-5 text-center text-sm"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-3)' }}
          data-testid="src-empty"
        >
          Источников пока нет. Нажмите «Добавить источник», чтобы задать приоритет и RICE.
        </p>
      ) : (
        <div className="space-y-3" data-testid="src-list">
          {drafts.map((d, i) => {
            const Icon = SOURCE_TYPE_ICON[d.type];
            const score = draftScore(d);
            const cardWarn =
              d.targetDate != null &&
              d.targetDate.length > 0 &&
              d.targetQuarter != null &&
              d.targetYear != null &&
              !isDateInQuarter(d.targetDate, d.targetQuarter, d.targetYear);
            return (
              <div
                key={d._key}
                className="rounded-lg border p-4"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
                data-testid={`src-card-${i}`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="icon-sm" aria-hidden="true" /> Источник {i + 1} ·{' '}
                    {SOURCE_TYPE_LABEL[d.type]}
                  </span>
                  <button
                    type="button"
                    className="row-icon-btn hover:text-[var(--color-danger)]"
                    data-testid={`src-remove-${i}`}
                    aria-label={`Убрать источник ${i + 1}`}
                    title="Убрать источник"
                    onClick={() => removeCard(d._key)}
                  >
                    <X className="icon-sm" aria-hidden="true" />
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`src-type-${i}`}>
                      Тип источника
                    </label>
                    <select
                      id={`src-type-${i}`}
                      className="input"
                      data-testid={`src-type-${i}`}
                      value={d.type}
                      onChange={(e) => patch(d._key, { type: e.target.value as SourceType })}
                    >
                      {SOURCE_TYPES_ORDER.map((t) => (
                        <option key={t} value={t}>
                          {SOURCE_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span className="label">
                      Источник <span className="t3 font-normal">— поиск по справочнику</span>
                    </span>
                    <SourceCombobox
                      value={d.name}
                      sources={dictionaries.sources}
                      currentType={d.type}
                      testidPrefix={`src-name-${i}`}
                      onChangeName={(name) => patch(d._key, { name })}
                      onPick={(ref: SourceRef) => patch(d._key, { name: ref.name, type: ref.type })}
                      onCreate={(name) => void createSource(d._key, name, d.type)}
                    />
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`src-priority-${i}`}>
                      Приоритет источника{' '}
                      <span className="t3 font-normal">— справочник проекта</span>
                    </label>
                    <select
                      id={`src-priority-${i}`}
                      className="input"
                      data-testid={`src-priority-${i}`}
                      value={d.priorityId}
                      onChange={(e) => {
                        if (e.target.value === '__add__') {
                          setAddPrioFor(d._key);
                          setNewPrioName('');
                          setNewPrioColor('blue');
                        } else {
                          patch(d._key, { priorityId: e.target.value });
                        }
                      }}
                    >
                      {priorities.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                      <option value="__add__">＋ Добавить свой вариант…</option>
                    </select>

                    {addPrioFor === d._key ? (
                      <div
                        className="mt-2 rounded-sm border border-dashed p-3"
                        style={{
                          borderColor: 'var(--color-primary)',
                          background: 'var(--color-primary-soft)',
                        }}
                        data-testid={`src-priority-add-${i}`}
                      >
                        <input
                          className="input mb-2"
                          placeholder="Название приоритета"
                          maxLength={40}
                          aria-label="Название нового приоритета"
                          data-testid={`src-priority-add-name-${i}`}
                          value={newPrioName}
                          onChange={(e) => setNewPrioName(e.target.value)}
                        />
                        <ColorPalettePicker
                          value={newPrioColor}
                          onChange={setNewPrioColor}
                          testidPrefix={`src-priority-add-color-${i}`}
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            data-testid={`src-priority-add-save-${i}`}
                            disabled={newPrioName.trim().length === 0 || addPriorityMut.isPending}
                            onClick={() => void submitNewPriority(d._key)}
                          >
                            Добавить
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            data-testid={`src-priority-add-cancel-${i}`}
                            onClick={() => setAddPrioFor(null)}
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <span className="label">Желаемый срок источника</span>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        className="input"
                        aria-label="Желаемый квартал источника"
                        data-testid={`src-quarter-${i}`}
                        value={d.targetQuarter ?? ''}
                        onChange={(e) =>
                          patch(d._key, {
                            targetQuarter: e.target.value
                              ? (e.target.value as TargetQuarter)
                              : undefined,
                          })
                        }
                      >
                        <option value="">Квартал: —</option>
                        {TARGET_QUARTERS.map((q) => (
                          <option key={q} value={q}>
                            {q}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        className="input"
                        placeholder="Год"
                        min={2020}
                        max={2100}
                        aria-label="Желаемый год источника"
                        data-testid={`src-year-${i}`}
                        value={d.targetYear ?? ''}
                        onChange={(e) =>
                          patch(d._key, {
                            targetYear: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </div>
                    <input
                      type="date"
                      className="input mt-2"
                      aria-label="Желаемая дата источника"
                      data-testid={`src-date-${i}`}
                      style={
                        cardWarn
                          ? {
                              borderColor: 'var(--color-warning)',
                              background: 'var(--color-warning-bg)',
                            }
                          : undefined
                      }
                      value={d.targetDate ?? ''}
                      onChange={(e) => patch(d._key, { targetDate: e.target.value || undefined })}
                    />
                    {cardWarn ? (
                      <p
                        className="mt-1 flex items-center gap-1.5 text-xs"
                        style={{ color: 'var(--color-warning-fg)' }}
                        data-testid={`src-date-warning-${i}`}
                      >
                        <TriangleAlert className="icon-sm" aria-hidden="true" />
                        Дата вне {d.targetQuarter} — предупреждение, сохранить можно
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* RICE — 4 selects with a live score (ФТ-B1) */}
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="label" htmlFor={`src-rice-reach-${i}`}>
                      Reach
                    </label>
                    <select
                      id={`src-rice-reach-${i}`}
                      className="input"
                      data-testid={`src-rice-reach-${i}`}
                      value={d.reach ?? ''}
                      onChange={(e) =>
                        patch(d._key, {
                          reach: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {REACH_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`src-rice-impact-${i}`}>
                      Impact
                    </label>
                    <select
                      id={`src-rice-impact-${i}`}
                      className="input"
                      data-testid={`src-rice-impact-${i}`}
                      value={d.impact ?? ''}
                      onChange={(e) =>
                        patch(d._key, {
                          impact: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {IMPACT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`src-rice-confidence-${i}`}>
                      Confidence
                    </label>
                    <select
                      id={`src-rice-confidence-${i}`}
                      className="input"
                      data-testid={`src-rice-confidence-${i}`}
                      value={d.confidence ?? ''}
                      onChange={(e) =>
                        patch(d._key, {
                          confidence: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {CONFIDENCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`src-rice-effort-${i}`}>
                      Effort
                    </label>
                    <select
                      id={`src-rice-effort-${i}`}
                      className="input"
                      data-testid={`src-rice-effort-${i}`}
                      value={d.effort ?? ''}
                      onChange={(e) =>
                        patch(d._key, {
                          effort: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {EFFORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div
                  className="mt-2 flex items-center justify-end gap-2 border-t pt-2 text-sm"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }}
                >
                  RICE этого источника:{' '}
                  <span className="mono font-bold" data-testid={`src-score-${i}`}>
                    {score === undefined ? '—' : score.toFixed(1)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Aggregate (ФТ-B2) */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
        data-testid="req-aggregate"
      >
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <strong>Итог требования</strong>
          <span className="t3">приоритет</span>
          {aggPriority ? (
            <PriorityBadge
              name={aggPriority.name}
              color={aggPriority.color}
              testid="req-aggregate-priority"
            />
          ) : (
            <span className="t3" data-testid="req-aggregate-priority-empty">
              —
            </span>
          )}
        </span>
        <span className="text-sm">
          RICE:{' '}
          <span className="mono font-bold" data-testid="req-aggregate-rice">
            {aggRice === undefined ? '—' : aggRice.toFixed(1)}
          </span>
        </span>
      </div>

      {/* PO decision — plan (ФТ-D2) */}
      <div>
        <h3 className="mb-2 text-sm font-bold">Решение PO — план реализации</h3>
        <div
          className="rounded-lg border p-4"
          style={{
            borderColor: 'var(--color-border)',
            borderLeft: '3px solid var(--color-primary)',
            background: 'var(--color-surface)',
          }}
          data-testid="po-decision"
        >
          {wishes.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="po-wishes">
              <span className="t3 text-xs font-semibold">Пожелания источников:</span>
              {wishes.map((w) => (
                <span
                  key={w.key}
                  className="rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
                  data-testid={`po-wish-${w.key}`}
                >
                  {w.name} — {w.text}
                </span>
              ))}
            </div>
          ) : (
            <p
              className="mb-3 text-xs"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="po-wishes-empty"
            >
              Пожеланий по срокам от источников пока нет.
            </p>
          )}

          {implemented ? (
            <p
              className="text-sm"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="po-implemented-note"
            >
              Требование помечено как реализованное — план и дата выпуска не задаются.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="po-quarter">
                  Квартал реализации
                </label>
                <select
                  id="po-quarter"
                  className="input"
                  data-testid="po-quarter"
                  value={targetQuarter ?? ''}
                  onChange={(e) =>
                    onTargetQuarter(e.target.value ? (e.target.value as TargetQuarter) : undefined)
                  }
                >
                  <option value="">—</option>
                  {TARGET_QUARTERS.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="po-year">
                  Год
                </label>
                <input
                  id="po-year"
                  type="number"
                  min={2020}
                  max={2100}
                  className="input"
                  data-testid="po-year"
                  value={targetYear ?? ''}
                  onChange={(e) =>
                    onTargetYear(e.target.value ? Number(e.target.value) : undefined)
                  }
                />
              </div>
              <div>
                <label className="label" htmlFor="po-release-date">
                  Дата выпуска <span className="t3 font-normal">(если необходимо)</span>
                </label>
                <input
                  id="po-release-date"
                  type="date"
                  className="input"
                  data-testid="po-release-date"
                  style={
                    releaseOutOfQuarter
                      ? {
                          borderColor: 'var(--color-warning)',
                          background: 'var(--color-warning-bg)',
                        }
                      : undefined
                  }
                  value={releaseDate}
                  onChange={(e) => onReleaseDate(e.target.value)}
                />
              </div>
              {releaseOutOfQuarter ? (
                <p
                  className="flex items-center gap-1.5 text-xs sm:col-span-3"
                  style={{ color: 'var(--color-warning-fg)' }}
                  data-testid="po-release-warning"
                >
                  <TriangleAlert className="icon-sm" aria-hidden="true" />
                  Дата выпуска вне {targetQuarter} {targetYear} — предупреждение, сохранить можно
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
