import { useMemo, useState } from 'react';
import { Check, Link2, Search, X } from 'lucide-react';
import { LINK_TYPES, type LinkType, type Requirement, type RequirementType } from '@po/core';
import { useCreateLink } from '../api/hooks';
import { errorMessage } from '../api/client';
import { LINK_TYPE_OPTIONS } from '../lib/linkTypes';
import { linkCandidateStatus } from '../lib/linkRules';
import { CRITICALITY_LABEL } from '../lib/criticality';
import { Modal } from './Modal';
import { BusyButton } from './BusyButton';

interface LinkModalProps {
  projectId: string;
  source: Requirement;
  requirements: Requirement[];
  onClose: () => void;
  /** T-517: pre-filter candidates to this type when opening from RequirementModal. */
  initialTypeFilter?: RequirementType;
}

/** Max search results rendered at once (§2.11: the cut is made visible). */
const MAX_RESULTS = 25;

/** Highlighted requirement name inside the «Итог» sentence (§2.11). */
function Name({ children }: { children: string }): React.ReactElement {
  return (
    <strong className="font-semibold underline decoration-dotted underline-offset-2">
      «{children}»
    </strong>
  );
}

/** «Итог» sentence per link type, target-first for hierarchy (link-modal mockup). */
function outcomeSentence(
  type: LinkType,
  sourceName: string,
  targetName: string | null,
): React.ReactElement {
  const src = <Name>{sourceName}</Name>;
  const tgt = targetName ? <Name>{targetName}</Name> : <span>«…»</span>;
  switch (type) {
    case 'RELATES_TO':
      return (
        <>
          Итог: {src} и {tgt} будут связаны двусторонней связью.
        </>
      );
    case 'CHILD_OF':
      return (
        <>
          Итог: {tgt} станет родителем {src}.
        </>
      );
    case 'PARENT_OF':
      return (
        <>
          Итог: {src} станет родителем {tgt}.
        </>
      );
    case 'DEPENDS_ON':
      return (
        <>
          Итог: {src} зависит от {tgt}.
        </>
      );
    case 'BLOCKED_BY':
      return (
        <>
          Итог: {src} блокируется {tgt}.
        </>
      );
  }
}

export function LinkModal({
  projectId,
  source,
  requirements,
  onClose,
  initialTypeFilter,
}: LinkModalProps): React.ReactElement {
  // §2.11: the safe symmetric type is the default, not CHILD_OF.
  const [type, setType] = useState<LinkType>('RELATES_TO');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Requirement | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [typeFilter] = useState<RequirementType | null>(initialTypeFilter ?? null);

  const createMut = useCreateLink(projectId);

  // UX-4: name-filter the candidates, then annotate each with a compatibility
  // status derived from the core integrity predicates (same rules the server
  // enforces). Incompatible targets stay visible but disabled with a reason.
  const { results, totalMatches } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = requirements
      .filter((r) => r.slug !== source.slug)
      .filter((r) => (typeFilter !== null ? r.type === typeFilter : true))
      .filter((r) => (q.length === 0 ? true : r.name.toLowerCase().includes(q)));
    return {
      totalMatches: matches.length,
      results: matches
        .slice(0, MAX_RESULTS)
        .map((r) => ({ req: r, status: linkCandidateStatus(requirements, source, type, r) })),
    };
  }, [requirements, search, source, type, typeFilter]);

  // The chosen target may become incompatible after the link type changes.
  const targetOk = target != null && linkCandidateStatus(requirements, source, type, target).ok;

  const submit = async (): Promise<void> => {
    if (!target || !targetOk) return;
    setApiError(null);
    try {
      await createMut.mutateAsync({ sourceSlug: source.slug, type, targetSlug: target.slug });
      onClose();
    } catch (err) {
      setApiError(errorMessage(err));
    }
  };

  // UX: explain why «Связать» is inactive instead of a silent dead button.
  const disabledReason =
    !createMut.isPending && (!target || !targetOk)
      ? !target
        ? 'Выберите требование для связи'
        : 'Требование несовместимо с выбранным типом связи'
      : null;

  const footer = (
    <>
      <span
        className="hint mr-auto self-center"
        data-testid={disabledReason ? 'link-submit-hint' : 'link-files-hint'}
      >
        {disabledReason ?? 'Связь запишется в оба .md-файла сразу'}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="link-cancel"
        onClick={onClose}
      >
        Отменить
      </button>
      <BusyButton
        className="btn btn-primary"
        busy={createMut.isPending}
        busyLabel="Связываем…"
        data-testid="link-submit"
        disabled={!target || !targetOk}
        title={disabledReason ?? undefined}
        onClick={() => void submit()}
      >
        Связать
      </BusyButton>
    </>
  );

  return (
    <Modal
      title="Новая связь"
      onClose={onClose}
      testid="link-modal"
      widthClass="max-w-xl"
      footer={footer}
    >
      <div
        className="rounded-lg p-3 text-sm"
        style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
        data-testid="link-source"
      >
        Источник: «{source.name}»
      </div>

      {/* ── Шаг 1 · цель связи ─────────────────────────────────────────────── */}
      <section aria-labelledby="link-target-h">
        <h3 id="link-target-h" className="mb-2 text-sm font-semibold">
          1 · Цель связи
        </h3>
        <div className="relative">
          <Search
            className="icon-sm t3 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            id="link-search"
            type="search"
            className="input !pl-9"
            placeholder="Поиск по имени требования…"
            aria-label="Поиск требования-цели"
            data-testid="link-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* §2.11: the chosen target is a chip UNDER the field — the search field
            keeps its single role and never turns into a display of the selection. */}
        {target ? (
          <div
            className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
            style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
            role="status"
            data-testid="link-target-chip"
          >
            <Link2 className="icon-sm flex-none" aria-hidden="true" />
            <span className="min-w-0 truncate">Цель: «{target.name}»</span>
            <button
              type="button"
              className="ml-auto rounded p-0.5 hover:bg-black/10"
              aria-label="Сбросить выбранную цель"
              data-testid="link-target-reset"
              onClick={() => setTarget(null)}
            >
              <X className="icon-sm" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div
          className="mt-2 overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--color-border)' }}
          role="listbox"
          aria-label="Результаты поиска"
          data-testid="link-results"
        >
          <div className="max-h-52 overflow-y-auto">
            {results.length === 0 ? (
              <p className="px-3 py-2 text-sm" style={{ color: 'var(--color-text-3)' }}>
                Ничего не найдено.
              </p>
            ) : (
              results.map(({ req: r, status }) => {
                const selected = target?.slug === r.slug;
                return (
                  <button
                    key={r.slug}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={!status.ok}
                    aria-disabled={!status.ok}
                    className="flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm last:border-b-0 disabled:cursor-not-allowed disabled:opacity-60 [&:not(:disabled)]:hover:bg-[var(--color-surface-2)]"
                    style={{
                      borderColor: 'var(--color-border)',
                      ...(selected
                        ? {
                            boxShadow: 'inset 0 0 0 2px var(--color-primary)',
                            background: 'var(--color-primary-soft)',
                          }
                        : undefined),
                    }}
                    data-testid={`link-result-${r.slug}`}
                    data-disabled={status.ok ? undefined : 'true'}
                    title={status.ok ? undefined : status.reason}
                    onClick={() => {
                      if (!status.ok) return;
                      setTarget(r);
                    }}
                  >
                    {selected ? (
                      <Check
                        className="icon-sm flex-none"
                        style={{ color: 'var(--color-primary)' }}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="w-4 flex-none" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate${selected ? ' font-medium' : ''}`}>
                        {r.name}
                      </span>
                      {status.ok ? (
                        <span className="t3 block text-xs">
                          {r.type === 'FUNCTION' ? 'ФТ' : 'НФТ'} ·{' '}
                          {CRITICALITY_LABEL[r.criticality]}
                        </span>
                      ) : (
                        <span
                          className="block text-xs"
                          style={{ color: 'var(--color-danger-fg)' }}
                          data-testid={`link-result-reason-${r.slug}`}
                        >
                          Недоступно: {status.reason}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* §2.11: the result cut is visible, not silent. */}
        {totalMatches > MAX_RESULTS ? (
          <p className="hint mt-2" role="status" data-testid="link-results-more">
            Показаны первые {MAX_RESULTS} из {totalMatches} — уточните запрос
          </p>
        ) : null}
      </section>

      {/* ── Шаг 2 · тип связи ──────────────────────────────────────────────── */}
      <section aria-labelledby="link-type-h">
        <h3 id="link-type-h" className="mb-2 text-sm font-semibold">
          2 · Тип связи
        </h3>
        <div
          className="space-y-2"
          role="radiogroup"
          aria-labelledby="link-type-h"
          data-testid="link-type"
        >
          {LINK_TYPE_OPTIONS.map((opt) => {
            const checked = type === opt.value;
            return (
              <label
                key={opt.value}
                className="flex cursor-pointer gap-2.5 rounded-sm border px-3 py-2.5 hover:bg-[var(--color-surface-2)]"
                style={
                  checked
                    ? {
                        borderColor: 'var(--color-primary)',
                        boxShadow: 'inset 0 0 0 1px var(--color-primary)',
                        background: 'var(--color-primary-soft)',
                      }
                    : { borderColor: 'var(--color-border)' }
                }
              >
                <input
                  type="radio"
                  name="link-type"
                  value={opt.value}
                  checked={checked}
                  className="mt-0.5 h-4 w-4 flex-none accent-[var(--color-primary)]"
                  data-testid={`link-type-${opt.value}`}
                  onChange={() => setType(opt.value)}
                />
                <span>
                  <span className="block text-sm font-semibold">{opt.label}</span>
                  <span className="t3 mt-0.5 block text-xs">{opt.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Итог человеческим предложением с подсветкой имён (§2.11). */}
      <p
        className="rounded-lg px-4 py-3 text-sm"
        style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
        role="status"
        data-testid="link-sentence"
      >
        {outcomeSentence(type, source.name, target?.name ?? null)}
      </p>

      {apiError ? (
        <div
          className="rounded-lg p-3 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
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
