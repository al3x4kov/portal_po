import { useMemo, useState } from 'react';
import { LINK_TYPES, type LinkType, type Requirement } from '@po/core';
import { useCreateLink } from '../api/hooks';
import { errorMessage } from '../api/client';
import { LINK_TYPE_OPTIONS, describeLink } from '../lib/linkTypes';
import { Modal } from './Modal';

interface LinkModalProps {
  projectId: string;
  source: Requirement;
  requirements: Requirement[];
  onClose: () => void;
}

export function LinkModal({
  projectId,
  source,
  requirements,
  onClose,
}: LinkModalProps): React.ReactElement {
  const [type, setType] = useState<LinkType>('CHILD_OF');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Requirement | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const createMut = useCreateLink(projectId);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requirements
      .filter((r) => r.slug !== source.slug)
      .filter((r) => (q.length === 0 ? true : r.name.toLowerCase().includes(q)))
      .slice(0, 25);
  }, [requirements, search, source.slug]);

  const submit = async (): Promise<void> => {
    if (!target) return;
    setApiError(null);
    try {
      await createMut.mutateAsync({ sourceSlug: source.slug, type, targetSlug: target.slug });
      onClose();
    } catch (err) {
      setApiError(errorMessage(err));
    }
  };

  const footer = (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="link-cancel"
        onClick={onClose}
      >
        Отменить
      </button>
      <button
        type="button"
        className="btn btn-primary"
        data-testid="link-submit"
        disabled={!target || createMut.isPending}
        onClick={() => void submit()}
      >
        Связать
      </button>
    </>
  );

  return (
    <Modal
      title="Связать требование"
      onClose={onClose}
      testid="link-modal"
      widthClass="max-w-lg"
      footer={footer}
    >
      <div
        className="rounded-lg p-3 text-sm"
        style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
        data-testid="link-source"
      >
        Связываем: «{source.name}»
      </div>

      <div>
        <label className="label" htmlFor="link-type">
          Тип связи
        </label>
        <select
          id="link-type"
          className="input"
          data-testid="link-type"
          value={type}
          onChange={(e) => setType(e.target.value as LinkType)}
        >
          {LINK_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="link-search">
          С каким требованием
        </label>
        <input
          id="link-search"
          className="input"
          placeholder="Поиск по названию…"
          data-testid="link-search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setTarget(null);
          }}
        />
        <div
          className="card mt-2 max-h-48 divide-y overflow-auto"
          style={{ borderColor: 'var(--color-border)' }}
          data-testid="link-results"
        >
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm" style={{ color: 'var(--color-text-3)' }}>
              Ничего не найдено.
            </p>
          ) : (
            results.map((r) => (
              <button
                key={r.slug}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
                style={
                  target?.slug === r.slug ? { background: 'var(--color-surface-2)' } : undefined
                }
                data-testid={`link-result-${r.slug}`}
                onClick={() => {
                  setTarget(r);
                  setSearch(r.name);
                }}
              >
                <span>{r.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                  {r.type}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div
        className="rounded-lg p-3 text-sm"
        style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
        data-testid="link-sentence"
      >
        Итог: {describeLink(source.name, type, target?.name ?? '…')}
      </div>

      {apiError ? (
        <div
          className="rounded-lg p-3 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
          data-testid="link-error"
        >
          {apiError}
        </div>
      ) : null}
    </Modal>
  );
}

/** Re-export for tests that need the canonical list. */
export const ALL_LINK_TYPES = LINK_TYPES;
