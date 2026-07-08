import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { PriorityColor, SourcePriority, SourceRef, SourceType } from '@po/core';
import {
  useAddPriority,
  useAddSource,
  useDeletePriority,
  useDeleteSource,
  useDictionaries,
  useProject,
  useUpdatePriority,
  useUpdateSource,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { useUiStore } from '../store/ui';
import { Sidebar } from '../components/Sidebar';
import { PathHeader } from '../components/PathHeader';
import { PriorityBadge } from '../components/PriorityBadge';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { SOURCE_TYPE_LABEL, SOURCE_TYPES_ORDER } from '../lib/sourceTypes';

function PrioritiesCard({ projectId }: { projectId: string }): React.ReactElement {
  const dict = useDictionaries(projectId);
  const addMut = useAddPriority(projectId);
  const updateMut = useUpdatePriority(projectId);
  const deleteMut = useDeletePriority(projectId);

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<PriorityColor>('blue');
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');

  const priorities = [...(dict.data?.priorities ?? [])].sort((a, b) => a.order - b.order);

  const rename = (p: SourcePriority, name: string): void => {
    if (name.trim() === p.name || name.trim().length === 0) return;
    setError(null);
    updateMut.mutate(
      { pid: p.id, input: { name: name.trim() } },
      { onError: (e) => setError(errorMessage(e)) },
    );
  };
  const recolor = (p: SourcePriority, color: PriorityColor): void => {
    setError(null);
    updateMut.mutate(
      { pid: p.id, input: { color } },
      { onError: (e) => setError(errorMessage(e)) },
    );
  };
  const swap = (a: SourcePriority, b: SourcePriority): void => {
    setError(null);
    updateMut.mutate({ pid: a.id, input: { order: b.order } });
    updateMut.mutate({ pid: b.id, input: { order: a.order } });
  };

  const submitAdd = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    setError(null);
    addMut.mutate(
      { name, color: newColor },
      {
        onSuccess: () => {
          setAdding(false);
          setNewName('');
          setNewColor('blue');
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  const confirmDelete = (pid: string): void => {
    setError(null);
    deleteMut.mutate(
      { pid, reassignTo: reassignTo || undefined },
      {
        onSuccess: () => {
          setDeleteFor(null);
          setReassignTo('');
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <section className="card overflow-hidden" data-testid="dict-priorities">
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <h2 className="font-bold">Приоритеты источников</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="prio-add-open"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="icon-sm" aria-hidden="true" /> Приоритет
        </button>
      </div>

      {error ? (
        <p
          className="px-4 py-2 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="prio-error"
        >
          {error}
        </p>
      ) : null}

      <ul>
        {priorities.map((p, i) => {
          const isDefault = p.id === 'default';
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
              style={{ borderColor: 'var(--color-border)' }}
              data-testid={`prio-row-${p.id}`}
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  className="row-icon-btn"
                  data-testid={`prio-up-${p.id}`}
                  aria-label={`Поднять «${p.name}»`}
                  disabled={i === 0}
                  onClick={() => swap(p, priorities[i - 1])}
                >
                  <ChevronUp className="icon-sm" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="row-icon-btn"
                  data-testid={`prio-down-${p.id}`}
                  aria-label={`Опустить «${p.name}»`}
                  disabled={i === priorities.length - 1}
                  onClick={() => swap(p, priorities[i + 1])}
                >
                  <ChevronDown className="icon-sm" aria-hidden="true" />
                </button>
              </div>

              <input
                className="input flex-1"
                style={{ minWidth: 140 }}
                defaultValue={p.name}
                maxLength={40}
                aria-label={`Название приоритета «${p.name}»`}
                data-testid={`prio-name-${p.id}`}
                onBlur={(e) => rename(p, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />

              <ColorPalettePicker
                value={p.color}
                onChange={(c) => recolor(p, c)}
                testidPrefix={`prio-color-${p.id}`}
              />

              <PriorityBadge name={p.name} color={p.color} testid={`prio-badge-${p.id}`} />

              {isDefault ? (
                <span
                  className="rounded px-2 py-0.5 text-[11px] font-bold"
                  style={{
                    background: 'var(--color-success-bg)',
                    color: 'var(--color-success-fg)',
                  }}
                  data-testid={`prio-default-${p.id}`}
                >
                  дефолт
                </span>
              ) : null}

              {deleteFor === p.id ? (
                <div
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`prio-delete-panel-${p.id}`}
                >
                  <label className="hint" htmlFor={`prio-reassign-${p.id}`}>
                    Перенести использующие в:
                  </label>
                  <select
                    id={`prio-reassign-${p.id}`}
                    className="input"
                    style={{ width: 'auto' }}
                    data-testid={`prio-reassign-${p.id}`}
                    value={reassignTo}
                    onChange={(e) => setReassignTo(e.target.value)}
                  >
                    <option value="">— выберите —</option>
                    {priorities
                      .filter((o) => o.id !== p.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    data-testid={`prio-delete-confirm-${p.id}`}
                    disabled={priorities.length > 1 && reassignTo === ''}
                    onClick={() => confirmDelete(p.id)}
                  >
                    Удалить
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid={`prio-delete-cancel-${p.id}`}
                    onClick={() => {
                      setDeleteFor(null);
                      setReassignTo('');
                    }}
                  >
                    Отмена
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="row-icon-btn ml-auto hover:text-[var(--color-danger)]"
                  data-testid={`prio-delete-${p.id}`}
                  aria-label={`Удалить приоритет «${p.name}»`}
                  disabled={priorities.length <= 1}
                  title={priorities.length <= 1 ? 'Нельзя удалить последний приоритет' : 'Удалить'}
                  onClick={() => {
                    setDeleteFor(p.id);
                    setReassignTo('');
                  }}
                >
                  <Trash2 className="icon-sm" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="flex flex-wrap items-center gap-3 p-4" data-testid="prio-add-form">
          <input
            className="input flex-1"
            style={{ minWidth: 160 }}
            placeholder="Название приоритета"
            maxLength={40}
            aria-label="Название нового приоритета"
            data-testid="prio-add-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd();
            }}
          />
          <ColorPalettePicker
            value={newColor}
            onChange={setNewColor}
            testidPrefix="prio-add-color"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="prio-add-save"
            disabled={newName.trim().length === 0 || addMut.isPending}
            onClick={submitAdd}
          >
            Добавить
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SourcesCard({ projectId }: { projectId: string }): React.ReactElement {
  const dict = useDictionaries(projectId);
  const addMut = useAddSource(projectId);
  const updateMut = useUpdateSource(projectId);
  const deleteMut = useDeleteSource(projectId);

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<SourceType>('CLIENT');

  const sources = [...(dict.data?.sources ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  const rename = (s: SourceRef, name: string): void => {
    if (name.trim() === s.name || name.trim().length === 0) return;
    setError(null);
    updateMut.mutate(
      { sid: s.id, input: { name: name.trim() } },
      { onError: (e) => setError(errorMessage(e)) },
    );
  };
  const retype = (s: SourceRef, type: SourceType): void => {
    setError(null);
    updateMut.mutate({ sid: s.id, input: { type } }, { onError: (e) => setError(errorMessage(e)) });
  };

  const submitAdd = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    setError(null);
    addMut.mutate(
      { name, type: newType },
      {
        onSuccess: () => {
          setAdding(false);
          setNewName('');
          setNewType('CLIENT');
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <section className="card overflow-hidden" data-testid="dict-sources">
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <h2 className="font-bold">Источники</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="source-add-open"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="icon-sm" aria-hidden="true" /> Источник
        </button>
      </div>

      {error ? (
        <p
          className="px-4 py-2 text-sm"
          role="alert"
          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
          data-testid="source-error"
        >
          {error}
        </p>
      ) : null}

      {sources.length === 0 && !adding ? (
        <p
          className="px-4 py-6 text-sm"
          style={{ color: 'var(--color-text-3)' }}
          data-testid="source-empty"
        >
          Справочник источников пуст — имена собираются автоматически из требований или добавьте
          вручную.
        </p>
      ) : (
        <ul>
          {sources.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
              style={{ borderColor: 'var(--color-border)' }}
              data-testid={`source-row-${s.id}`}
            >
              <input
                className="input flex-1"
                style={{ minWidth: 160 }}
                defaultValue={s.name}
                maxLength={100}
                aria-label={`Имя источника «${s.name}»`}
                data-testid={`source-name-${s.id}`}
                onBlur={(e) => rename(s, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
              <select
                className="input"
                style={{ width: 'auto' }}
                aria-label={`Тип источника «${s.name}»`}
                data-testid={`source-type-${s.id}`}
                value={s.type}
                onChange={(e) => retype(s, e.target.value as SourceType)}
              >
                {SOURCE_TYPES_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {SOURCE_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="row-icon-btn ml-auto hover:text-[var(--color-danger)]"
                data-testid={`source-delete-${s.id}`}
                aria-label={`Удалить источник «${s.name}»`}
                onClick={() =>
                  deleteMut.mutate(s.id, { onError: (e) => setError(errorMessage(e)) })
                }
              >
                <Trash2 className="icon-sm" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-wrap items-center gap-3 p-4" data-testid="source-add-form">
          <input
            className="input flex-1"
            style={{ minWidth: 160 }}
            placeholder="Имя источника"
            maxLength={100}
            aria-label="Имя нового источника"
            data-testid="source-add-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd();
            }}
          />
          <select
            className="input"
            style={{ width: 'auto' }}
            aria-label="Тип нового источника"
            data-testid="source-add-type"
            value={newType}
            onChange={(e) => setNewType(e.target.value as SourceType)}
          >
            {SOURCE_TYPES_ORDER.map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="source-add-save"
            disabled={newName.trim().length === 0 || addMut.isPending}
            onClick={submitAdd}
          >
            Добавить
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function Dictionaries(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const dict = useDictionaries(id);
  const openModal = useUiStore((s) => s.openModal);

  return (
    <>
      <Sidebar
        projectId={id}
        activePage="dictionaries"
        onOpenExport={() => openModal({ kind: 'export' })}
        onOpenTasks={() => openModal({ kind: 'export-tasks' })}
      />
      <div
        className="flex min-h-screen flex-col"
        style={{ marginLeft: 'var(--sidebar-width)' }}
        data-testid="dictionaries-page"
      >
        <PathHeader
          name={projectQuery.data?.name ?? id}
          mainPath={projectQuery.data?.mainPath ?? ''}
        />
        <main className="w-full flex-1 space-y-6 p-6">
          <div>
            <h1 className="text-xl font-bold">Справочники проекта</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
              Приоритеты источников (порядок = старшинство) и список источников. Значения
              используются на вкладке «Приоритизация» требований.
            </p>
          </div>

          {dict.isLoading ? (
            <p
              className="text-sm"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="dict-loading"
            >
              Загрузка справочников…
            </p>
          ) : dict.isError ? (
            <p
              className="rounded-lg p-3 text-sm"
              role="alert"
              style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
              data-testid="dict-error"
            >
              {errorMessage(dict.error)}
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <PrioritiesCard projectId={id} />
              <SourcesCard projectId={id} />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
