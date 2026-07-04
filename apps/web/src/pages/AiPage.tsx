import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AI_DEFAULT_BASE_URL, type AiConfigUpdate } from '@po/core';
import {
  useAiConfig,
  useDeleteAiKey,
  useListAiModels,
  useProject,
  useSaveAiConfig,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Sidebar } from '../components/Sidebar';
import { PathHeader } from '../components/PathHeader';
import { useUiStore } from '../store/ui';
import { RequirementModal } from '../components/RequirementModal';
import { ExportModal } from '../components/ExportModal';
import { ExportTasksModal } from '../components/ExportTasksModal';
import { useRequirements } from '../api/hooks';

type Status = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null;

function GroupTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p
      className="text-sm font-bold uppercase tracking-wide"
      style={{ color: 'var(--color-text-3)' }}
    >
      {children}
    </p>
  );
}

export function AiPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const configQuery = useAiConfig(id);
  const config = configQuery.data;

  const saveMut = useSaveAiConfig();
  const modelsMut = useListAiModels();
  const deleteKeyMut = useDeleteAiKey();

  // ── Local form state ──────────────────────────────────────────────────────
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState(AI_DEFAULT_BASE_URL);
  const [model, setModel] = useState('');
  const [manualModel, setManualModel] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(false);

  // Hydrate baseURL/model once the saved config arrives (don't clobber edits).
  useEffect(() => {
    if (config && !hydrated) {
      setBaseURL(config.baseURL || AI_DEFAULT_BASE_URL);
      if (config.model) setModel(config.model);
      setHydrated(true);
    }
  }, [config, hydrated]);

  const busy = saveMut.isPending || modelsMut.isPending || deleteKeyMut.isPending;
  const hasStoredKey = Boolean(config?.hasApiKey);
  const keyProvided = hasStoredKey || apiKey.trim().length > 0;

  // Options: loaded models + the currently saved model (so it is never lost).
  const modelOptions = useMemo(() => {
    const set = new Set<string>(models);
    if (model) set.add(model);
    return [...set];
  }, [models, model]);

  const buildUpdate = (): AiConfigUpdate => {
    const update: AiConfigUpdate = { baseURL: baseURL.trim(), projectId: id };
    if (apiKey.trim().length > 0) update.apiKey = apiKey;
    if (model.trim().length > 0) update.model = model.trim();
    return update;
  };

  const handleSaveAndLoad = async (): Promise<void> => {
    setStatus(null);
    try {
      await saveMut.mutateAsync(buildUpdate());
      const res = await modelsMut.mutateAsync();
      setModels(res.models);
      setApiKey('');
      // Auto-select the first model if none chosen yet.
      if (!model && res.models.length > 0) setModel(res.models[0]);
      setStatus({
        kind: 'success',
        text: `Подключение успешно · загружено ${res.models.length} ${
          res.models.length === 1 ? 'модель' : 'моделей'
        }`,
      });
    } catch (err) {
      setStatus({ kind: 'error', text: `Не удалось подключиться: ${errorMessage(err)}` });
    }
  };

  const handleDeleteKey = async (): Promise<void> => {
    try {
      await deleteKeyMut.mutateAsync();
      setConfirmDeleteKey(false);
      // Drop any previous success/error status so the empty state
      // («Введите API-ключ…») becomes visible again.
      setStatus(null);
    } catch {
      // The error is rendered inside the ConfirmDialog via its `error` prop.
    }
  };

  const handleSave = async (): Promise<void> => {
    setStatus(null);
    try {
      await saveMut.mutateAsync(buildUpdate());
      setApiKey('');
      setStatus({ kind: 'success', text: 'Настройки сохранены' });
    } catch (err) {
      setStatus({ kind: 'error', text: `Не удалось сохранить: ${errorMessage(err)}` });
    }
  };

  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const requirements = reqQuery.data?.requirements ?? [];
  const nameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of requirements) m.set(r.slug, r.name);
    return m;
  }, [requirements]);

  return (
    <>
      <Sidebar
        projectId={id}
        activePage="ai"
        onOpenExport={() => openModal({ kind: 'export' })}
        onOpenTasks={() => openModal({ kind: 'export-tasks' })}
      />
      <div
        className="flex min-h-screen flex-col"
        style={{ marginLeft: 'var(--sidebar-width)' }}
        data-testid="ai-page"
      >
        <PathHeader
          name={projectQuery.data?.name ?? id}
          mainPath={projectQuery.data?.mainPath ?? ''}
        />

        <main className="w-full flex-1 space-y-4 p-6">
          <h1 className="text-xl font-bold">Экран «AI»</h1>
          <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
            Проект: <strong>{projectQuery.data?.name ?? id}</strong> · раздел AI
          </p>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* LEFT: connection */}
            <section className="card space-y-4 p-5">
              <GroupTitle>Подключение к AI Hub</GroupTitle>

              {/* API key */}
              <div>
                <label className="label" htmlFor="ai-key-input">
                  API-ключ
                </label>
                <div className="flex gap-2">
                  <input
                    id="ai-key-input"
                    className="input"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    placeholder={hasStoredKey ? '••••••••••••' : 'Введите API-ключ'}
                    autoComplete="off"
                    data-testid="ai-key-input"
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="ai-key-toggle"
                    aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? '🙈' : '👁'}
                  </button>
                </div>
                {hasStoredKey ? (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p
                      className="text-xs"
                      style={{ color: 'var(--color-success-fg)' }}
                      data-testid="ai-key-saved"
                    >
                      ✓ ключ сохранён
                    </p>
                    <button
                      type="button"
                      className="text-xs underline"
                      style={{ color: 'var(--color-danger-fg)' }}
                      data-testid="ai-delete-key"
                      disabled={busy}
                      onClick={() => setConfirmDeleteKey(true)}
                    >
                      Удалить ключ
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
                    Ключ хранится локально и не отображается повторно.
                  </p>
                )}
              </div>

              {/* Base URL */}
              <div>
                <label className="label" htmlFor="ai-baseurl-input">
                  Base URL
                </label>
                <input
                  id="ai-baseurl-input"
                  className="input"
                  type="text"
                  value={baseURL}
                  data-testid="ai-baseurl-input"
                  onChange={(e) => setBaseURL(e.target.value)}
                />
              </div>

              <button
                type="button"
                className="btn btn-primary w-full"
                data-testid="ai-load-models"
                disabled={busy || !keyProvided}
                title={!keyProvided ? 'Введите API-ключ, чтобы загрузить модели' : undefined}
                onClick={() => void handleSaveAndLoad()}
              >
                {modelsMut.isPending ? '⟳ Загрузка моделей…' : 'Сохранить и загрузить модели'}
              </button>

              {/* Model */}
              <div>
                <label className="label" htmlFor="ai-model-select">
                  Модель (для этого проекта)
                </label>
                {manualModel || modelOptions.length === 0 ? (
                  <input
                    id="ai-model-select"
                    className="input"
                    type="text"
                    value={model}
                    placeholder="Напр.: GigaChat-2-Pro"
                    data-testid="ai-model-manual"
                    onChange={(e) => setModel(e.target.value)}
                  />
                ) : (
                  <select
                    id="ai-model-select"
                    className="input"
                    value={model}
                    data-testid="ai-model-select"
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">— выберите модель —</option>
                    {modelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
                <p className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>
                  {manualModel ? (
                    <>
                      Список загружен?{' '}
                      <button
                        type="button"
                        className="underline"
                        style={{ color: 'var(--color-primary)' }}
                        data-testid="ai-model-mode-select"
                        onClick={() => setManualModel(false)}
                      >
                        Выбрать из списка
                      </button>
                    </>
                  ) : (
                    <>
                      Список недоступен?{' '}
                      <button
                        type="button"
                        className="underline"
                        style={{ color: 'var(--color-primary)' }}
                        data-testid="ai-model-mode-manual"
                        onClick={() => setManualModel(true)}
                      >
                        Ввести model id вручную
                      </button>
                    </>
                  )}
                </p>
              </div>

              {/* Connection status */}
              <div data-testid="ai-status">
                {status?.kind === 'success' ? (
                  <p
                    className="rounded-lg p-2 text-xs"
                    style={{
                      background: 'var(--color-success-bg)',
                      color: 'var(--color-success-fg)',
                    }}
                    data-state="success"
                  >
                    ● {status.text}
                  </p>
                ) : status?.kind === 'error' ? (
                  <p
                    className="rounded-lg p-2 text-xs"
                    style={{
                      background: 'var(--color-danger-bg)',
                      color: 'var(--color-danger-fg)',
                    }}
                    role="alert"
                    data-state="error"
                  >
                    {status.text}
                  </p>
                ) : !keyProvided ? (
                  <p
                    className="rounded-lg p-2 text-xs"
                    style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                    data-state="empty"
                  >
                    Введите API-ключ, чтобы загрузить модели
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                className="btn btn-primary w-full"
                data-testid="ai-save"
                disabled={busy}
                onClick={() => void handleSave()}
              >
                Сохранить
              </button>
            </section>

            {/* RIGHT: instruction */}
            <section className="card space-y-4 p-5">
              <GroupTitle>Инструкция по подключению</GroupTitle>
              <ol className="space-y-3 text-sm" style={{ color: 'var(--color-text-2)' }}>
                <li className="flex gap-3">
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}
                  >
                    1
                  </span>
                  <span>
                    <strong>Авторизация в AIHub.</strong> Откройте{' '}
                    <a
                      href="https://hub.ai.sbt/"
                      target="_blank"
                      rel="noopener"
                      className="underline"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      hub.ai.sbt
                    </a>{' '}
                    (новая вкладка), нажмите «Войти» справа вверху, войдите под персональной учётной
                    записью.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}
                  >
                    2
                  </span>
                  <span>
                    <strong>Получение API-ключа.</strong> Раздел «API-ключи» → «Создать новый ключ»
                    → выберите тип → название (напр. «test») → «Создать ключ» → скопируйте и
                    сохраните.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}
                  >
                    3
                  </span>
                  <span>
                    <strong>Base URL.</strong>{' '}
                    <code style={{ fontFamily: 'var(--font-mono)' }}>{AI_DEFAULT_BASE_URL}</code>
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}
                  >
                    4
                  </span>
                  <span>
                    <strong>Список моделей.</strong> Загрузите модели и выберите нужную в списке
                    слева.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}
                  >
                    5
                  </span>
                  <span>
                    <strong>Первый запрос.</strong> AIHub совместим с OpenAI API — достаточно
                    сменить <code style={{ fontFamily: 'var(--font-mono)' }}>base_url</code>.
                  </span>
                </li>
              </ol>
            </section>
          </div>
        </main>

        {confirmDeleteKey ? (
          <ConfirmDialog
            title="Удалить API-ключ?"
            message="Чат и генерация описаний перестанут работать, пока вы не введёте новый ключ. Выбранные модели проектов сохранятся."
            confirmLabel="Удалить ключ"
            danger
            busy={deleteKeyMut.isPending}
            error={deleteKeyMut.isError ? errorMessage(deleteKeyMut.error) : null}
            onConfirm={() => void handleDeleteKey()}
            onCancel={() => {
              setConfirmDeleteKey(false);
              deleteKeyMut.reset();
            }}
          />
        ) : null}

        {modal?.kind === 'requirement' ? (
          <RequirementModal
            projectId={id}
            reqType={modal.reqType}
            requirement={modal.requirement}
            nameBySlug={nameBySlug}
            linkFrom={modal.linkFrom}
            linkType={modal.linkType}
            focusField={modal.focusField}
            onClose={closeModal}
          />
        ) : null}

        {modal?.kind === 'export' ? (
          <ExportModal projectId={id} requirements={requirements} onClose={closeModal} />
        ) : null}

        {modal?.kind === 'export-tasks' ? (
          <ExportTasksModal projectId={id} requirements={requirements} onClose={closeModal} />
        ) : null}
      </div>
    </>
  );
}
