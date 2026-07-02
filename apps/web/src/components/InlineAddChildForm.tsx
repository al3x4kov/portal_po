import React, { useRef, useEffect, useState } from 'react';

interface InlineAddChildFormProps {
  parentSlug: string;
  depth: number; // depth of child node (parent.depth + 1)
  onSave: (name: string) => Promise<void>; // call with name, close after resolve
  onCancel: () => void;
}

export function InlineAddChildForm({
  parentSlug: _parentSlug,
  depth,
  onSave,
  onCancel,
}: InlineAddChildFormProps): React.ReactElement {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') onCancel();
  }

  // Indent = (depth * 20px for tree guides) + 8px padding
  const indent = depth * 20 + 8;

  return (
    <tr data-testid="inline-add-child-form" className="bg-[var(--color-primary-soft)]">
      <td colSpan={999} style={{ padding: '4px 8px 4px 0' }}>
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            paddingLeft: `${indent}px`,
          }}
        >
          {/* Small new node indicator */}
          <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontSize: '14px' }}>
            +
          </span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Название дочернего ФТ..."
            disabled={saving}
            data-testid="inline-add-child-input"
            aria-label="Название нового дочернего требования"
            style={{
              flex: 1,
              border: '1px solid var(--color-primary)',
              borderRadius: '4px',
              padding: '3px 8px',
              fontSize: '13px',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              outline: 'none',
            }}
          />
          {error ? (
            <span
              role="alert"
              style={{ color: 'var(--color-danger-fg)', fontSize: '12px' }}
            >
              {error}
            </span>
          ) : null}
          <button
            type="submit"
            disabled={!name.trim() || saving}
            data-testid="inline-add-child-save"
            style={{
              padding: '3px 12px',
              borderRadius: '4px',
              border: 'none',
              background: 'var(--color-primary)',
              color: '#fff',
              fontSize: '13px',
              cursor: name.trim() && !saving ? 'pointer' : 'not-allowed',
              opacity: name.trim() && !saving ? 1 : 0.5,
            }}
          >
            {saving ? '...' : 'Создать'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            data-testid="inline-add-child-cancel"
            aria-label="Отмена"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
              color: 'var(--color-text-3)',
            }}
          >
            &#x2715;
          </button>
        </form>
      </td>
    </tr>
  );
}
