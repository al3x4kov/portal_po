import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CRITICALITIES,
  SOURCE_PRESETS,
  TARGET_QUARTERS,
  type InfoItem,
  type Link,
  type LinkType,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { requirementFormSchema, type RequirementFormValues } from '../lib/requirementForm';
import {
  useCreateLink,
  useCreateRequirement,
  useDeleteLink,
  useUpdateRequirement,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';
import { useNameCheck } from '../hooks/useNameCheck';
import { Modal } from './Modal';
import { LinkList } from './LinkList';
import { ConfirmDialog } from './ConfirmDialog';
import { AiGenerationPanel } from './AiGenerationPanel';

interface RequirementModalProps {
  projectId: string;
  reqType: RequirementType;
  requirement?: Requirement;
  /** Project-wide slug → name map so link targets render by name (T2). */
  nameBySlug?: Map<string, string>;
  /** T-517: full requirement objects by slug so we can classify links by target type. */
  requirementsBySlug?: Map<string, Requirement>;
  /** T4: after creating this NFR, link it from this source slug. */
  linkFrom?: string;
  linkType?: LinkType;
  /** T-517: Called when the user requests to add a new link; receives a type hint
   *  (FUNCTION | NFR) so LinkModal can pre-filter candidates. */
  onAddLink?: (typeHint: RequirementType) => void;
  onClose: () => void;
  /** T-515: auto-focus a specific field when the modal opens. */
  focusField?: 'description';
  /**
   * FR-21: when true, criticality and implemented are not pre-filled with defaults
   * so the user must explicitly choose them (used when creating a child requirement).
   */
  noDefaultCriticality?: boolean;
}

const FORM_ID = 'requirement-form';
const MAX_DESCRIPTION = 5000;

function typeNounGenitive(type: RequirementType): string {
  return type === 'FUNCTION' ? 'функциональных требований' : 'нефункциональных требований';
}

function takenMessage(type: RequirementType): string {
  return type === 'FUNCTION'
    ? 'Функция с таким именем уже существует'
    : 'НФТ с таким именем уже существует';
}

export function RequirementModal({
  projectId,
  reqType,
  requirement,
  nameBySlug,
  requirementsBySlug,
  linkFrom,
  linkType,
  onAddLink,
  onClose,
  focusField,
  noDefaultCriticality = false,
}: RequirementModalProps): React.ReactElement {
  const isEdit = Boolean(requirement);
  const [apiError, setApiError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'save' | null>(null);

  // FR-20: infoItems managed as local state (not part of RHF, appended to payload)
  const [infoItems, setInfoItems] = useState<InfoItem[]>(requirement?.infoItems ?? []);
  const [showInfoForm, setShowInfoForm] = useState(false);
  const [infoType, setInfoType] = useState('');
  const [infoValue, setInfoValue] = useState('');
  // inline delete confirmation index (-1 = none)
  const [infoDeleteIdx, setInfoDeleteIdx] = useState(-1);

  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);

  // T-515: auto-focus the description textarea when requested.
  useEffect(() => {
    if (focusField === 'description') {
      const timer = setTimeout(() => {
        descriptionRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [focusField]);

  const createMut = useCreateRequirement(projectId);
  const updateMut = useUpdateRequirement(projectId);
  const createLinkMut = useCreateLink(projectId);
  const deleteLinkMut = useDeleteLink(projectId);

  // T2/T3: local copy of the requirement's links so a deletion disappears at once.
  const [links, setLinks] = useState<Link[]>(requirement?.links ?? []);
  // T3: which link (if any) is awaiting inline delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<{ type: LinkType; targetSlug: string } | null>(
    null,
  );

  // T4: name of the requirement the new one will be linked to/from.
  const linkFromName = linkFrom ? (nameBySlug?.get(linkFrom) ?? linkFrom) : null;

  // FR-21 fix: for a CHILD_OF preset the *newly created* requirement is the child,
  // i.e. the SOURCE of the edge (created CHILD_OF linkFrom). For other presets
  // (e.g. FT BLOCKED_BY new NFR) linkFrom stays the source. Getting this wrong
  // reparents the existing node under the new one and inverts the hierarchy.
  const createdIsSource = linkType === 'CHILD_OF';

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<RequirementFormValues>({
    resolver: zodResolver(requirementFormSchema),
    defaultValues: {
      type: requirement?.type ?? reqType,
      name: requirement?.name ?? '',
      criticality: requirement?.criticality ?? (noDefaultCriticality ? undefined : 'MEDIUM'),
      description: requirement?.description ?? '',
      implemented: requirement?.implemented ?? (noDefaultCriticality ? undefined : false),
      targetQuarter: requirement?.targetQuarter,
      targetYear: requirement?.targetYear,
      source: requirement?.source ?? '',
    },
  });

  const name = watch('name');
  const implemented = watch('implemented');
  const criticality = watch('criticality');
  const description = watch('description') ?? '';

  // Clear conditional fields when the requirement becomes implemented.
  useEffect(() => {
    if (implemented) {
      setValue('targetQuarter', undefined);
      setValue('targetYear', undefined);
    }
  }, [implemented, setValue]);

  // Real-time uniqueness check (FR-6.6), extracted to a hook (BE-5).
  const { nameTaken, nameOk } = useNameCheck(projectId, reqType, name ?? '', requirement?.slug);

  const busy = createMut.isPending || updateMut.isPending;
  const submitDisabled =
    busy || nameTaken || (name ?? '').trim().length === 0 || !criticality || implemented == null;

  // UX: never leave «Сохранить» disabled without telling the user what is missing.
  const missingFields: string[] = [];
  if ((name ?? '').trim().length === 0) missingFields.push('название');
  else if (nameTaken) missingFields.push('другое название (текущее занято)');
  if (!criticality) missingFields.push('критичность');
  if (implemented == null) missingFields.push('статус реализации');
  const disabledReason =
    submitDisabled && !busy && missingFields.length > 0
      ? `Заполните: ${missingFields.join(', ')}`
      : null;

  const buildPayload = (values: RequirementFormValues) => ({
    name: values.name.trim(),
    criticality: values.criticality,
    description:
      values.description && values.description.length > 0 ? values.description : undefined,
    implemented: values.implemented,
    targetQuarter: values.implemented ? undefined : values.targetQuarter,
    targetYear: values.implemented ? undefined : values.targetYear,
    source: values.source && values.source.trim().length > 0 ? values.source.trim() : undefined,
    infoItems: infoItems.length > 0 ? infoItems : undefined,
  });

  const doSave = async (values: RequirementFormValues): Promise<void> => {
    setApiError(null);
    try {
      if (requirement) {
        await updateMut.mutateAsync({ slug: requirement.slug, input: buildPayload(values) });
      } else {
        const created = await createMut.mutateAsync({ type: reqType, ...buildPayload(values) });
        // Wire the preset link once the requirement exists. Direction depends on the
        // relationship: CHILD_OF ⇒ created is the child (source); otherwise linkFrom is
        // the source (e.g. ФТ BLOCKED_BY new НФТ).
        if (linkFrom && linkType) {
          await createLinkMut.mutateAsync(
            createdIsSource
              ? { sourceSlug: created.slug, type: linkType, targetSlug: linkFrom }
              : { sourceSlug: linkFrom, type: linkType, targetSlug: created.slug },
          );
        }
      }
      onClose();
    } catch (err) {
      setApiError(errorMessage(err));
    }
  };

  // T3: confirm inline deletion of a single link (removes the reciprocal pair server-side).
  const confirmDeleteLink = async (): Promise<void> => {
    if (!pendingDelete || !requirement) return;
    setApiError(null);
    try {
      await deleteLinkMut.mutateAsync({
        sourceSlug: requirement.slug,
        type: pendingDelete.type,
        targetSlug: pendingDelete.targetSlug,
      });
      setLinks((prev) =>
        prev.filter(
          (l) => !(l.type === pendingDelete.type && l.targetSlug === pendingDelete.targetSlug),
        ),
      );
      setPendingDelete(null);
    } catch (err) {
      setApiError(errorMessage(err));
    }
  };

  const onValid = (values: RequirementFormValues): void => {
    if (isEdit) setConfirm('save');
    else void doSave(values);
  };

  const handleCancel = (): void => {
    if (isEdit && isDirty) setConfirm('cancel');
    else onClose();
  };

  const typeBadge = reqType === 'FUNCTION' ? 'Функциональное' : 'Нефункциональное';
  const title = isEdit
    ? 'Редактирование требования'
    : reqType === 'FUNCTION'
      ? 'Новая функция'
      : 'Новый НФТ';

  const footer = (
    <>
      {disabledReason ? (
        <span
          className="mr-auto self-center text-xs"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="req-submit-hint"
        >
          {disabledReason}
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="req-cancel"
        onClick={handleCancel}
      >
        Отменить
      </button>
      <button
        type="submit"
        form={FORM_ID}
        className="btn btn-primary"
        data-testid="req-submit"
        disabled={submitDisabled}
        title={disabledReason ?? undefined}
      >
        Сохранить
      </button>
    </>
  );

  const nameStatus = errors.name ? (
    <p
      className="mt-1.5 text-xs"
      style={{ color: 'var(--color-danger)' }}
      data-testid="req-name-status"
      data-state="invalid"
    >
      {errors.name.message}
    </p>
  ) : nameTaken ? (
    <p
      className="mt-1.5 flex items-center gap-1.5 text-xs"
      style={{ color: 'var(--color-danger)' }}
      data-testid="req-name-status"
      data-state="taken"
    >
      {takenMessage(reqType)}
    </p>
  ) : nameOk ? (
    <p
      className="mt-1.5 flex items-center gap-1.5 text-xs"
      style={{ color: 'var(--color-success-fg)' }}
      data-testid="req-name-status"
      data-state="ok"
    >
      ✓ Имя уникально среди {typeNounGenitive(reqType)}
    </p>
  ) : null;

  return (
    <Modal
      title={title}
      onClose={handleCancel}
      testid="requirement-modal"
      widthClass="max-w-2xl"
      badge={typeBadge}
      footer={footer}
    >
      <form id={FORM_ID} onSubmit={handleSubmit(onValid)} className="space-y-6" noValidate>
        {apiError ? (
          <div
            className="rounded-lg p-3 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            data-testid="req-error"
          >
            {apiError}
          </div>
        ) : null}

        {/* T4 · preset-link hint (creating an NFR from a functional requirement) */}
        {linkFrom ? (
          <div
            className="flex items-start gap-3 rounded-lg p-3 text-sm"
            style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
            data-testid="nfr-from-ft-hint"
          >
            <span>
              {createdIsSource ? (
                <>
                  Создаваемая функция будет дочерней для «<b>{linkFromName}</b>»{' '}
                  <span className="opacity-80">(CHILD_OF)</span>.
                </>
              ) : (
                <>
                  Будет связано: «<b>{linkFromName}</b>» блокируется этим НФТ{' '}
                  <span className="opacity-80">(BLOCKED_BY)</span>.
                </>
              )}
            </span>
          </div>
        ) : null}

        {/* Block 1 · identity */}
        <div>
          <label className="label" htmlFor="req-name-input">
            Название <span style={{ color: 'var(--color-danger)' }}>*</span>
          </label>
          <input
            id="req-name-input"
            className="input"
            data-testid="req-name"
            autoFocus
            {...register('name')}
          />
          {nameStatus}
        </div>

        <hr style={{ borderColor: 'var(--color-border)' }} />

        {/* Block 2 · classification */}
        <div>
          <span className="label">
            Критичность <span style={{ color: 'var(--color-danger)' }}>*</span>
          </span>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            role="radiogroup"
            aria-label="Критичность"
            data-testid="req-criticality"
          >
            {CRITICALITIES.map((c) => {
              const on = criticality === c;
              return (
                <label
                  key={c}
                  className="flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border px-2 py-2.5 text-[13px] font-semibold"
                  data-testid={`req-criticality-${c.toLowerCase()}`}
                  style={{
                    borderColor: on ? CRITICALITY_COLOR_VAR[c] : 'var(--color-border)',
                    borderWidth: on ? 2 : 1,
                    color: on ? 'var(--color-text)' : 'var(--color-text-2)',
                  }}
                >
                  <input type="radio" value={c} className="sr-only" {...register('criticality')} />
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: CRITICALITY_COLOR_VAR[c] }}
                    aria-hidden="true"
                  />
                  {CRITICALITY_LABEL[c]}
                </label>
              );
            })}
          </div>
          {errors.criticality ? (
            <p
              className="mt-1.5 text-xs"
              style={{ color: 'var(--color-danger)' }}
              data-testid="req-criticality-error"
            >
              Выберите уровень критичности
            </p>
          ) : null}
        </div>

        {/* Block 2b · source (FR-19) */}
        <div>
          <label className="label" htmlFor="req-source">
            Источник требования
          </label>
          <input
            id="req-source"
            className="input"
            list="source-presets"
            placeholder="Не задан"
            data-testid="req-source"
            {...register('source', { setValueAs: (v: string) => v })}
          />
          <datalist id="source-presets">
            {SOURCE_PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>

        {/* Block 3 · implementation status + conditional target */}
        <div>
          <span className="label">
            Статус реализации <span style={{ color: 'var(--color-danger)' }}>*</span>
          </span>
          <div className="grid grid-cols-2 gap-2" data-testid="req-implemented">
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-sm border px-3 py-2.5 text-sm font-semibold"
              style={
                implemented
                  ? {
                      borderColor: 'var(--color-primary)',
                      background: 'var(--color-primary-soft)',
                      color: 'var(--color-primary)',
                    }
                  : { borderColor: 'var(--color-border)' }
              }
              aria-pressed={implemented}
              data-testid="req-implemented-yes"
              onClick={() =>
                setValue('implemented', true, { shouldDirty: true, shouldValidate: true })
              }
            >
              Реализовано
            </button>
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-sm border px-3 py-2.5 text-sm font-semibold"
              style={
                implemented === false
                  ? {
                      borderColor: 'var(--color-primary)',
                      background: 'var(--color-primary-soft)',
                      color: 'var(--color-primary)',
                    }
                  : { borderColor: 'var(--color-border)' }
              }
              aria-pressed={implemented === false}
              data-testid="req-implemented-no"
              onClick={() =>
                setValue('implemented', false, { shouldDirty: true, shouldValidate: true })
              }
            >
              Не реализовано
            </button>
          </div>

          {errors.implemented ? (
            <p
              className="mt-1.5 text-xs"
              style={{ color: 'var(--color-danger)' }}
              data-testid="req-implemented-error"
            >
              Выберите статус реализации
            </p>
          ) : null}

          {implemented === false ? (
            <div
              className="mt-3 grid gap-4 rounded-lg p-4 sm:grid-cols-2"
              style={{ background: 'var(--color-surface-2)' }}
              data-testid="req-target"
            >
              <p className="text-xs sm:col-span-2" style={{ color: 'var(--color-text-2)' }}>
                Плановый срок обязателен, пока требование не реализовано.
              </p>
              <div>
                <label className="label" htmlFor="req-quarter">
                  Квартал <span style={{ color: 'var(--color-danger)' }}>*</span>
                </label>
                <select
                  id="req-quarter"
                  className="input"
                  data-testid="req-quarter"
                  {...register('targetQuarter', {
                    setValueAs: (v) => (v === '' || v == null ? undefined : v),
                  })}
                >
                  <option value="">—</option>
                  {TARGET_QUARTERS.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
                {errors.targetQuarter ? (
                  <p
                    className="mt-1.5 text-xs"
                    style={{ color: 'var(--color-danger)' }}
                    data-testid="req-quarter-error"
                  >
                    {errors.targetQuarter.message}
                  </p>
                ) : null}
              </div>
              <div>
                <label className="label" htmlFor="req-year">
                  Год <span style={{ color: 'var(--color-danger)' }}>*</span>
                </label>
                <input
                  id="req-year"
                  type="number"
                  min={2020}
                  max={2100}
                  className="input"
                  data-testid="req-year"
                  {...register('targetYear', {
                    setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
                  })}
                />
                {errors.targetYear ? (
                  <p
                    className="mt-1.5 text-xs"
                    style={{ color: 'var(--color-danger)' }}
                    data-testid="req-year-error"
                  >
                    {errors.targetYear.message}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <hr style={{ borderColor: 'var(--color-border)' }} />

        {/* Block 4 · description */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="label m-0" htmlFor="req-description">
              Описание
            </label>
            <span
              className="text-xs"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="req-desc-count"
            >
              {description.length} / {MAX_DESCRIPTION}
            </span>
          </div>
          <textarea
            id="req-description"
            rows={5}
            className="input"
            style={{ resize: 'vertical' }}
            data-testid="req-description"
            {...register('description', {
              setValueAs: (v: string) => v,
            })}
            ref={(el) => {
              descriptionRef.current = el;
              const { ref } = register('description');
              if (typeof ref === 'function') ref(el);
            }}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
            Поддерживается Markdown.
          </p>

          {/* T-803 · AI Hub generation (append to description, human-in-the-loop) */}
          <AiGenerationPanel
            projectId={projectId}
            requirementName={name ?? ''}
            requirementType={reqType}
            criticality={criticality}
            currentDescription={description}
            onApply={(generated) => {
              const cur = getValues('description') ?? '';
              setValue('description', cur ? `${cur}\n${generated}` : generated, {
                shouldDirty: true,
                shouldValidate: true,
              });
            }}
          />
        </div>

        {/* Block 4b · infoItems (FR-20) */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="label m-0">Справочная информация</span>
            <button
              type="button"
              className="btn btn-ghost px-2 py-0.5 text-xs"
              data-testid="info-add-btn"
              onClick={() => {
                setShowInfoForm(true);
                setInfoType('');
                setInfoValue('');
              }}
            >
              + Добавить
            </button>
          </div>

          {/* Saved info items */}
          {infoItems.length > 0 ? (
            <ul className="mb-2 space-y-1">
              {infoItems.map((item, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
                  style={{ background: 'var(--color-surface-2)' }}
                >
                  <span>
                    <span className="font-semibold">{item.type}</span>
                    <span style={{ color: 'var(--color-text-3)' }}>: </span>
                    {item.value}
                  </span>
                  <span className="flex items-center gap-2">
                    {infoDeleteIdx === i ? (
                      <>
                        <span className="text-xs" style={{ color: 'var(--color-danger)' }}>
                          Удалить?
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost px-1.5 py-0.5 text-xs"
                          style={{ color: 'var(--color-danger)' }}
                          data-testid={`info-delete-confirm-${i}`}
                          onClick={() => {
                            setInfoItems((prev) => prev.filter((_, idx) => idx !== i));
                            setInfoDeleteIdx(-1);
                          }}
                        >
                          Да
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost px-1.5 py-0.5 text-xs"
                          data-testid={`info-delete-cancel-${i}`}
                          onClick={() => setInfoDeleteIdx(-1)}
                        >
                          Нет
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost px-1.5 py-0.5 text-xs"
                        style={{ color: 'var(--color-text-3)' }}
                        data-testid={`info-delete-${i}`}
                        onClick={() => setInfoDeleteIdx(i)}
                        aria-label={`Удалить запись ${item.type}`}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Inline add form */}
          {showInfoForm ? (
            <div
              className="flex items-center gap-2 rounded-lg p-3"
              style={{ background: 'var(--color-surface-2)' }}
            >
              <input
                type="text"
                className="input flex-1"
                placeholder="тип"
                maxLength={50}
                value={infoType}
                onChange={(e) => setInfoType(e.target.value)}
                data-testid="info-type-input"
                aria-label="Тип справочной информации"
              />
              <input
                type="text"
                className="input flex-1"
                placeholder="значение"
                maxLength={100}
                value={infoValue}
                onChange={(e) => setInfoValue(e.target.value)}
                data-testid="info-value-input"
                aria-label="Значение справочной информации"
              />
              <button
                type="button"
                className="btn btn-primary px-2 py-1.5 text-xs"
                data-testid="info-apply-btn"
                disabled={!infoType.trim() || !infoValue.trim()}
                onClick={() => {
                  if (!infoType.trim() || !infoValue.trim()) return;
                  setInfoItems((prev) => [
                    ...prev,
                    { type: infoType.trim(), value: infoValue.trim() },
                  ]);
                  setInfoType('');
                  setInfoValue('');
                  setShowInfoForm(false);
                }}
              >
                ✓
              </button>
              <button
                type="button"
                className="btn btn-ghost px-2 py-1.5 text-xs"
                data-testid="info-cancel-btn"
                onClick={() => {
                  setShowInfoForm(false);
                  setInfoType('');
                  setInfoValue('');
                }}
              >
                ✕
              </button>
            </div>
          ) : null}
        </div>

        {/* Block 5 · links (T2/T3/T-517) — edit mode only; a new requirement has no links yet.
            Split into «Связи с ФТ» and «Связи с НФТ» sections.
            - FT section: hierarchy links (CHILD_OF/PARENT_OF) + links whose target is FUNCTION,
              plus unresolved links (when requirementsBySlug is absent) as a safe fallback.
            - NFR section: links whose target type is NFR (requires requirementsBySlug). */}
        {isEdit
          ? (() => {
              const HIER_TYPES = new Set<LinkType>(['CHILD_OF', 'PARENT_OF']);

              const ftLinks = links.filter((l) => {
                if (HIER_TYPES.has(l.type)) return true;
                const targetReq = requirementsBySlug?.get(l.targetSlug);
                if (targetReq) return targetReq.type === 'FUNCTION';
                // Target type unknown (requirementsBySlug not provided): fall back to FT section.
                return true;
              });

              const nfrLinks = links.filter((l) => {
                if (HIER_TYPES.has(l.type)) return false;
                const targetReq = requirementsBySlug?.get(l.targetSlug);
                return targetReq ? targetReq.type === 'NFR' : false;
              });

              const sharedLinkListProps = {
                pendingDelete,
                deleting: deleteLinkMut.isPending,
                onRequestDelete: (l: Link) =>
                  setPendingDelete({ type: l.type, targetSlug: l.targetSlug }),
                onCancelDelete: () => setPendingDelete(null),
                onConfirmDelete: () => void confirmDeleteLink(),
              };

              return (
                <>
                  <hr style={{ borderColor: 'var(--color-border)' }} />

                  {/* FT section */}
                  <div data-testid="req-links-ft">
                    <div
                      className="mb-2 flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
                      style={{
                        background: 'var(--color-primary-soft)',
                        color: 'var(--color-primary)',
                      }}
                    >
                      <span className="text-xs font-bold uppercase tracking-wide">
                        Связи с ФТ ({ftLinks.length})
                      </span>
                      {onAddLink ? (
                        <button
                          type="button"
                          className="btn btn-ghost px-2 py-0.5 text-xs"
                          data-testid="req-links-add-ft"
                          onClick={() => onAddLink('FUNCTION')}
                        >
                          + Связать с ФТ
                        </button>
                      ) : null}
                    </div>
                    {ftLinks.length === 0 ? (
                      <p
                        className="px-2 py-3 text-sm"
                        style={{ color: 'var(--color-text-3)', fontStyle: 'italic' }}
                        data-testid="req-links-ft-empty"
                      >
                        Нет связей с ФТ — добавьте первую
                      </p>
                    ) : (
                      <LinkList links={ftLinks} nameBySlug={nameBySlug} {...sharedLinkListProps} />
                    )}
                  </div>

                  {/* NFR section */}
                  <div data-testid="req-links-nfr">
                    <div
                      className="mb-2 flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
                      style={{
                        background: 'var(--color-surface-2)',
                        color: 'var(--color-text-2)',
                      }}
                    >
                      <span className="text-xs font-bold uppercase tracking-wide">
                        Связи с НФТ ({nfrLinks.length})
                      </span>
                      {onAddLink ? (
                        <button
                          type="button"
                          className="btn btn-ghost px-2 py-0.5 text-xs"
                          data-testid="req-links-add-nfr"
                          onClick={() => onAddLink('NFR')}
                        >
                          + Связать с НФТ
                        </button>
                      ) : null}
                    </div>
                    {nfrLinks.length === 0 ? (
                      <p
                        className="px-2 py-3 text-sm"
                        style={{ color: 'var(--color-text-3)', fontStyle: 'italic' }}
                        data-testid="req-links-nfr-empty"
                      >
                        Нет связей с НФТ — добавьте первую
                      </p>
                    ) : (
                      <LinkList links={nfrLinks} nameBySlug={nameBySlug} {...sharedLinkListProps} />
                    )}
                  </div>
                </>
              );
            })()
          : null}
      </form>

      {confirm === 'save' ? (
        <ConfirmDialog
          testid="req-save-confirm"
          title="Сохранить изменения?"
          message="Изменения требования будут сохранены."
          confirmLabel="Сохранить"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void doSave(getValues());
          }}
        />
      ) : null}

      {confirm === 'cancel' ? (
        <ConfirmDialog
          testid="req-cancel-confirm"
          title="Отменить изменения?"
          message="Несохранённые изменения будут потеряны."
          confirmLabel="Отменить изменения"
          cancelLabel="Продолжить редактирование"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}
