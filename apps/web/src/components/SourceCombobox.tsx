import { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { SourceRef, SourceType } from '@po/core';
import { SOURCE_TYPE_LABEL } from '../lib/sourceTypes';

export interface SourceComboboxProps {
  /** Current source name (controlled). */
  value: string;
  /** All known project sources (the dictionary) to search within. */
  sources: readonly SourceRef[];
  /** Type of the current card — used as the default type for a freshly created source. */
  currentType: SourceType;
  /** Free-text edit of the name (no dictionary side-effect). */
  onChangeName: (name: string) => void;
  /** Pick an existing dictionary entry (carries its type). */
  onPick: (ref: SourceRef) => void;
  /** «Создать новый источник» — auto-collect into the dictionary right away. */
  onCreate: (name: string) => void;
  testidPrefix: string;
  disabled?: boolean;
}

/** Split `text` around the first case-insensitive occurrence of `q` for highlighting. */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <b style={{ color: 'var(--color-primary)' }}>{text.slice(idx, idx + q.length)}</b>
      {text.slice(idx + q.length)}
    </>
  );
}

/**
 * todo_19 (T-205, ФТ-A3): combobox that searches the project source dictionary
 * by name, highlights the match and offers «Создать новый источник» when no
 * exact match exists. Creating auto-collects the name into the dictionary
 * immediately (ФТ-C2.1) via the `onCreate` callback.
 */
export function SourceCombobox({
  value,
  sources,
  currentType,
  onChangeName,
  onPick,
  onCreate,
  testidPrefix,
  disabled,
}: SourceComboboxProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = value.trim();

  const matches = useMemo(() => {
    if (query.length === 0) return sources.slice(0, 8);
    const q = query.toLowerCase();
    return sources.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);
  }, [sources, query]);

  const exact = useMemo(
    () => sources.some((s) => s.name.trim().toLowerCase() === query.toLowerCase()),
    [sources, query],
  );
  const canCreate = query.length > 0 && !exact;

  const closeSoon = (): void => {
    blurTimer.current = setTimeout(() => setOpen(false), 120);
  };
  const cancelClose = (): void => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  };

  return (
    <div className="relative" data-testid={`${testidPrefix}-combo`}>
      <div
        className="flex items-center gap-2 rounded-sm border px-2.5"
        style={{
          background: 'var(--color-surface)',
          borderColor: open ? 'var(--color-primary)' : 'var(--color-border)',
          outline: open ? '2px solid var(--color-primary)' : undefined,
        }}
      >
        <Search
          size={15}
          aria-hidden="true"
          style={{ color: 'var(--color-text-3)', flex: 'none' }}
        />
        <input
          className="w-full bg-transparent py-2 text-sm outline-none"
          style={{ color: 'var(--color-text)' }}
          value={value}
          placeholder="Начните вводить имя источника…"
          aria-label="Источник — поиск по справочнику проекта"
          data-testid={`${testidPrefix}-input`}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={closeSoon}
          onChange={(e) => {
            onChangeName(e.target.value);
            setOpen(true);
          }}
        />
      </div>

      {open && (matches.length > 0 || canCreate) ? (
        <div
          className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-sm border shadow-lg"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          onMouseDown={cancelClose}
          role="listbox"
          data-testid={`${testidPrefix}-menu`}
        >
          {matches.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-primary-soft)]"
              data-testid={`${testidPrefix}-opt-${s.id}`}
              onClick={() => {
                onPick(s);
                setOpen(false);
              }}
            >
              <span className="min-w-0 truncate">{highlight(s.name, query)}</span>
              <span className="flex-none text-[11.5px]" style={{ color: 'var(--color-text-3)' }}>
                {SOURCE_TYPE_LABEL[s.type]}
              </span>
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[13px] font-semibold hover:bg-[var(--color-primary-soft)]"
              style={{ color: 'var(--color-primary)', borderColor: 'var(--color-border)' }}
              data-testid={`${testidPrefix}-create`}
              onClick={() => {
                onCreate(query);
                setOpen(false);
              }}
            >
              ＋ Создать новый источник «{query}» ({SOURCE_TYPE_LABEL[currentType]})
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
