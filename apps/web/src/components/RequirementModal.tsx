import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import {
  CRITICALITIES,
  TARGET_QUARTERS,
  type Link,
  type LinkType,
  type Requirement,
  type RequirementType,
} from '@po/core';
import { requirementFormSchema, type RequirementFormValues } from '../lib/requirementForm';
import { requirementsApi } from '../api/endpoints';
import {
  useCreateLink,
  useCreateRequirement,
  useDeleteLink,
  useUpdateRequirement,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';
import { LINK_TYPE_LABEL } from '../lib/linkTypes';
import { useDebounce } from '../lib/useDebounce';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface RequirementModalProps {
  projectId: string;
  reqType: RequirementType;
  requirement?: Requirement;
  /** Project-wide slug → name map so link targets render by name (T2). */
  nameBySlug?: Map<string, string>;
  /** T4: after creating this NFR, link it from this source slug. */
  linkFrom?: string;
  linkType?: LinkType;
  onClose: () => void;
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
  linkFrom,
  linkType,
  onClose,
}: RequirementModalProps): React.ReactElement {
  const isEdit = Boolean(requirement);
  const [apiError, setApiError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'save' | null>(null);

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

  // T4: name of the functional requirement the new NFR will be linked from.
  const linkFromName = linkFrom ? (nameBySlug?.get(linkFrom) ?? linkFrom) : null;

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
      criticality: requirement?.criticality ?? 'MEDIUM',
      description: requirement?.description ?? '',
      implemented: requirement?.implemented ?? false,
      targetQuarter: requirement?.targetQuarter,
      targetYear: requirement?.targetYear,
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

  // Real-time uniqueness check (FR-6.6): debounced GET .../check-name.
  const debouncedName = useDebounce((name ?? '').trim(), 350);
  const nameQuery = useQuery({
    queryKey: ['checkName', projectId, reqType, debouncedName, requirement?.slug ?? null],
    queryFn: () => requirementsApi.checkName(projectId, reqType, debouncedName, requirement?.slug),
    enabled: debouncedName.length > 0,
  });

  const nameTaken = nameQuery.data?.available === false;
  const nameOk = nameQuery.data?.available === true;

  const busy = createMut.isPending || updateMut.isPending;
  const submitDisabled = busy || nameTaken || (name ?? '').trim().length === 0;

  const buildPayload = (values: RequirementFormValues) => ({
    name: values.name.trim(),
    criticality: values.criticality,
    description:
      values.description && values.description.length > 0 ? values.description : undefined,
    implemented: values.implemented,
    targetQuarter: values.implemented ? undefined : values.targetQuarter,
    targetYear: values.implemented ? undefined : values.targetYear,
  });

  const doSave = async (values: RequirementFormValues): Promise<void> => {
    setApiError(null);
    try {
      if (requirement) {
        await updateMut.mutateAsync({ slug: requirement.slug, input: buildPayload(values) });
      } else {
        const created = await createMut.mutateAsync({ type: reqType, ...buildPayload(values) });
        // T4: wire the preset link (ФТ BLOCKED_BY new НФТ) once the NFR exists.
        if (linkFrom && linkType) {
          await createLinkMut.mutateAsync({
            sourceSlug: linkFrom,
            type: linkType,
            targetSlug: created.slug,
          });
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
      style={{ color: 'var(--color-success)' }}
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
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            data-testid="req-error"
          >
            {apiError}
          </div>
        ) : null}

        {/* T4 · preset-link hint (creating an NFR from a functional requirement) */}
        {linkFrom ? (
          <div
            className="flex items-start gap-3 rounded-lg p-3 text-sm"
            style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}
            data-testid="nfr-from-ft-hint"
          >
            <span>
              Будет связано: «<b>{linkFromName}</b>» блокируется этим НФТ{' '}
              <span className="opacity-80">(BLOCKED_BY)</span>.
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
        </div>

        {/* Block 3 · implementation status + conditional target */}
        <div>
          <span className="label">Статус реализации</span>
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
                !implemented
                  ? {
                      borderColor: 'var(--color-primary)',
                      background: 'var(--color-primary-soft)',
                      color: 'var(--color-primary)',
                    }
                  : { borderColor: 'var(--color-border)' }
              }
              aria-pressed={!implemented}
              data-testid="req-implemented-no"
              onClick={() =>
                setValue('implemented', false, { shouldDirty: true, shouldValidate: true })
              }
            >
              Не реализовано
            </button>
          </div>

          {!implemented ? (
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
            {...register('description')}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
            Поддерживается Markdown.
          </p>
        </div>

        {/* Block 5 · links (T2/T3) — edit mode only; a new requirement has no links yet. */}
        {isEdit ? (
          <>
            <hr style={{ borderColor: 'var(--color-border)' }} />
            <div>
              <span className="label">
                Связи{' '}
                <span className="font-normal" style={{ color: 'var(--color-text-3)' }}>
                  ({links.length})
                </span>
              </span>
              {links.length === 0 ? (
                <p
                  className="rounded-lg px-3 py-4 text-center text-sm"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}
                  data-testid="req-links-empty"
                >
                  Связей нет
                </p>
              ) : (
                <div className="space-y-1.5" data-testid="req-links">
                  {links.map((l) => {
                    const targetName = nameBySlug?.get(l.targetSlug) ?? l.targetSlug;
                    const isPending =
                      pendingDelete?.type === l.type && pendingDelete?.targetSlug === l.targetSlug;
                    return (
                      <div
                        key={`${l.type}-${l.targetSlug}`}
                        data-testid={`req-link-${l.targetSlug}`}
                        data-link-type={l.type}
                      >
                        {isPending ? (
                          <div
                            className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
                            style={{ background: 'var(--color-danger-bg)' }}
                          >
                            <div className="min-w-0 flex-1">
                              <p
                                className="text-sm font-medium"
                                style={{ color: 'var(--color-danger)' }}
                              >
                                Удалить связь «{LINK_TYPE_LABEL[l.type]} «{targetName}»»?
                              </p>
                              <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
                                Связь исчезнет у обоих требований.
                              </p>
                            </div>
                            <div className="flex flex-none items-center gap-2">
                              <button
                                type="button"
                                className="btn btn-secondary py-1 text-xs"
                                data-testid="req-link-del-cancel"
                                onClick={() => setPendingDelete(null)}
                              >
                                Отменить
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger py-1 text-xs"
                                data-testid="req-link-del-confirm"
                                disabled={deleteLinkMut.isPending}
                                onClick={() => void confirmDeleteLink()}
                              >
                                Удалить
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                            style={{ borderColor: 'var(--color-border)' }}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">
                                <span style={{ color: 'var(--color-text-3)' }}>
                                  {LINK_TYPE_LABEL[l.type]}
                                </span>{' '}
                                <span className="font-medium">«{targetName}»</span>
                              </p>
                              <p
                                className="text-[11px] uppercase tracking-wide"
                                style={{ color: 'var(--color-text-3)' }}
                              >
                                {l.type}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="btn btn-ghost flex-none px-2 py-1 text-xs"
                              style={{ color: 'var(--color-danger)' }}
                              data-testid={`req-link-del-${l.targetSlug}`}
                              aria-label={`Удалить связь «${targetName}»`}
                              onClick={() =>
                                setPendingDelete({ type: l.type, targetSlug: l.targetSlug })
                              }
                            >
                              Удалить
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
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
