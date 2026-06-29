import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { CRITICALITIES, TARGET_QUARTERS, type Requirement, type RequirementType } from '@po/core';
import { requirementFormSchema, type RequirementFormValues } from '../lib/requirementForm';
import { requirementsApi } from '../api/endpoints';
import { useCreateRequirement, useUpdateRequirement } from '../api/hooks';
import { errorMessage } from '../api/client';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { useDebounce } from '../lib/useDebounce';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface RequirementModalProps {
  projectId: string;
  reqType: RequirementType;
  requirement?: Requirement;
  onClose: () => void;
}

const FORM_ID = 'requirement-form';

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
  onClose,
}: RequirementModalProps): React.ReactElement {
  const isEdit = Boolean(requirement);
  const [apiError, setApiError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'save' | null>(null);

  const createMut = useCreateRequirement(projectId);
  const updateMut = useUpdateRequirement(projectId);

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
    queryKey: ['checkName', projectId, reqType, debouncedName, requirement?.id ?? null],
    queryFn: () => requirementsApi.checkName(projectId, reqType, debouncedName, requirement?.id),
    enabled: debouncedName.length > 0,
  });

  const nameTaken = nameQuery.data?.available === false;
  const nameOk = nameQuery.data?.available === true;

  const busy = createMut.isPending || updateMut.isPending;
  const applyDisabled = busy || nameTaken || (name ?? '').trim().length === 0;

  const buildPayload = (values: RequirementFormValues) => ({
    name: values.name.trim(),
    criticality: values.criticality,
    description: values.description && values.description.length > 0 ? values.description : undefined,
    implemented: values.implemented,
    targetQuarter: values.implemented ? undefined : values.targetQuarter,
    targetYear: values.implemented ? undefined : values.targetYear,
  });

  const doSave = async (values: RequirementFormValues): Promise<void> => {
    setApiError(null);
    try {
      if (requirement) {
        await updateMut.mutateAsync({ rid: requirement.id, input: buildPayload(values) });
      } else {
        await createMut.mutateAsync({ type: reqType, ...buildPayload(values) });
      }
      onClose();
    } catch (err) {
      setApiError(errorMessage(err));
    }
  };

  const onValid = (values: RequirementFormValues): void => {
    if (isEdit) {
      setConfirm('save');
    } else {
      void doSave(values);
    }
  };

  const handleCancel = (): void => {
    if (isEdit && isDirty) setConfirm('cancel');
    else onClose();
  };

  const title = isEdit
    ? 'Редактирование требования'
    : reqType === 'FUNCTION'
      ? 'Новая функция'
      : 'Новый НФТ';

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" data-testid="req-cancel" onClick={handleCancel}>
        Отменить
      </button>
      <button type="submit" form={FORM_ID} className="btn btn-primary" data-testid="req-apply" disabled={applyDisabled}>
        Применить
      </button>
    </>
  );

  return (
    <Modal title={title} onClose={handleCancel} testid="requirement-modal" footer={footer}>
      <form id={FORM_ID} onSubmit={handleSubmit(onValid)} className="space-y-5" noValidate>
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

        <div>
          <label className="label" htmlFor="req-name-input">
            Название <span style={{ color: 'var(--color-danger)' }}>*</span>
          </label>
          <input id="req-name-input" className="input" data-testid="req-name-input" {...register('name')} />
          {errors.name ? (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--color-danger)' }} data-testid="req-name-validation">
              {errors.name.message}
            </p>
          ) : nameTaken ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-danger)' }} data-testid="req-name-error">
              {takenMessage(reqType)}
            </p>
          ) : nameOk ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-success)' }} data-testid="req-name-ok">
              ✓ Имя уникально среди {typeNounGenitive(reqType)}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="req-criticality">
              Критичность <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <select id="req-criticality" className="input" data-testid="req-criticality" {...register('criticality')}>
              {CRITICALITIES.map((c) => (
                <option key={c} value={c}>
                  {CRITICALITY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="label">Статус реализации</span>
            <div className="flex gap-2">
              <button
                type="button"
                className={`input flex-1 text-center ${implemented ? 'font-semibold' : ''}`}
                style={implemented ? { borderColor: 'var(--color-primary)' } : undefined}
                aria-pressed={implemented}
                data-testid="req-implemented-yes"
                onClick={() => setValue('implemented', true, { shouldDirty: true, shouldValidate: true })}
              >
                Реализовано
              </button>
              <button
                type="button"
                className={`input flex-1 text-center ${!implemented ? 'font-semibold' : ''}`}
                style={!implemented ? { borderColor: 'var(--color-primary)' } : undefined}
                aria-pressed={!implemented}
                data-testid="req-implemented-no"
                onClick={() => setValue('implemented', false, { shouldDirty: true, shouldValidate: true })}
              >
                Не реализовано
              </button>
            </div>
          </div>
        </div>

        {!implemented ? (
          <div
            className="grid gap-4 rounded-lg p-4 sm:grid-cols-2"
            style={{ background: 'var(--color-surface-2)' }}
            data-testid="req-target-fields"
          >
            <div>
              <label className="label" htmlFor="req-quarter">
                Квартал <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <select
                id="req-quarter"
                className="input"
                data-testid="req-quarter"
                {...register('targetQuarter', { setValueAs: (v) => (v === '' || v == null ? undefined : v) })}
              >
                <option value="">—</option>
                {TARGET_QUARTERS.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
              {errors.targetQuarter ? (
                <p className="mt-1.5 text-xs" style={{ color: 'var(--color-danger)' }} data-testid="req-quarter-error">
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
                <p className="mt-1.5 text-xs" style={{ color: 'var(--color-danger)' }} data-testid="req-year-error">
                  {errors.targetYear.message}
                </p>
              ) : null}
            </div>
            <p className="text-xs sm:col-span-2" style={{ color: 'var(--color-text-3)' }}>
              Квартал и год обязательны, пока требование не реализовано.
            </p>
          </div>
        ) : null}

        <div>
          <label className="label" htmlFor="req-description">
            Описание
          </label>
          <textarea id="req-description" rows={4} className="input" data-testid="req-description" {...register('description')} />
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
            Поддерживается Markdown · до 5000 символов.
          </p>
        </div>
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
