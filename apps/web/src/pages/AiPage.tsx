import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Eye, EyeOff, Trash2, TriangleAlert } from 'lucide-react';
import { AI_DEFAULT_BASE_URL, type AiConfigUpdate } from '@po/core';
import {
  useAiConfig,
  useAiModelsRefresh,
  useDeleteAiKey,
  useProject,
  useRequirements,
  useSaveAiConfig,
} from '../api/hooks';
import { errorMessage } from '../api/client';
import { plural } from '../lib/plural';
import { BusyButton } from '../components/BusyButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ModelListNotice, ModelRefreshButton } from '../components/ModelRefresh';
import { Sidebar } from '../components/Sidebar';
import { PathHeader } from '../components/PathHeader';
import { useUiStore } from '../store/ui';
import { RequirementModal } from '../components/RequirementModal';
import { ExportModal } from '../components/ExportModal';
import { ExportTasksModal } from '../components/ExportTasksModal';

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

function StepNum({ n }: { n: number }): React.ReactElement {
  return (
    <span
      className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold"
      style={{ background: 'var(--color-primary)', color: '#fff' }}
      aria-hidden="true"
    >
      {n}
    </span>
  );
}

/**
 * «Подключение AI» (ai-page mockup, §2.16): a SINGLE primary «Сохранить» that
 * writes key + model + base URL together, a secondary «Обновить список» next
 * to the model select, and the save/verify status right UNDER the save button.
 */
export function AiPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const configQuery = useAiConfig(id);
  const config = configQuery.data;

  const saveMut = useSaveAiConfig();
  const deleteKeyMut = useDeleteAiKey();

  // ── Local form state ──────────────────────────────────────────────────────
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState(AI_DEFAULT_BASE_URL);
  const [model, setModel] = useState('');
  const [manualModel, setManualModel] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(false);

  // A3: shared model-list logic; a vanished selection falls back to the first
  // model with an inline notice (fetch on explicit action only).
  const modelsRefresh = useAiModelsRefresh({
    enabled: false,
    selectedModel: model,
    onModelReset: setModel,
  });

  // Hydrate baseURL/model once saved config arrives (don't clobber edits).
  useEffect(() => {
    if (config && !hydrated) {
      setBaseURL(config.baseURL || AI_DEFAULT_BASE_URL);
      if (config.model) setModel(config.model);
      setHydrated(true);
    }
  }, [config, hydrated]);

  const busy = saveMut.isPending || modelsRefresh.isFetching || deleteKeyMut.isPending;
  const hasStoredKey = Boolean(config?.hasApiKey);
  const keyProvided = hasStoredKey || apiKey.trim().length > 0;

  // Options: loaded models + currently saved model (so it is never lost).
  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsRefresh.models);
    if (model) set.add(model);
    return [...set];
  }, [modelsRefresh.models, model]);

  const buildUpdate = (): AiConfigUpdate => {
    const update: AiConfigUpdate = { baseURL: baseURL.trim(), projectId: id };
    if (apiKey.trim().length > 0) update.apiKey = apiKey;
    if (model.trim().length > 0) update.model = model.trim();
    return update;
  };

  /**
   * §2.16.1: the ONE primary button — saves key + model + base URL together.
   * Status (success / danger) is rendered right under the button (§2.16.4).
   */
  const handleSave = async (): Promise<void> => {
    setStatus(null);
    try {
      await saveMut.mutateAsync(buildUpdate());
      setApiKey('');
      setStatus({ kind: 'success', text: 'Настройки сохранены' });
    } catch (err) {
      setStatus({
        kind: 'error',
        text: `Не удалось подключиться: ${errorMessage(err)}. Настройки не сохранены.`,
      });
    }
  };

  /**
   * «Обновить список» next to the model select. Models are listed with the
   * key STORED on the server, so a freshly typed key is saved first (this is
   * the old «Сохранить и загрузить модели» flow relocated to the refresh
   * button); the connection status lands under «Сохранить».
   */
  const handleRefreshModels = async (): Promise<void> => {
    if (apiKey.trim().length > 0) {
      setStatus(null);
      try {
        await saveMut.mutateAsync(buildUpdate());
      } catch (err) {
        setStatus({
          kind: 'error',
          text: `Не удалось подключиться: ${errorMessage(err)}. Настройки не сохранены.`,
        });
        return;
      }
      const res = await modelsRefresh.refresh();
      if (!res.ok) {
        // One error message for the whole flow — under the save button.
        modelsRefresh.clearNotice();
        setStatus({ kind: 'error', text: `Не удалось подключиться: ${errorMessage(res.error)}` });
        return;
      }
      setApiKey('');
      if (!model && res.models.length > 0) setModel(res.models[0]);
      setStatus({
        kind: 'success',
        text: `Подключение успешно · загружено ${res.models.length} ${plural(
          res.models.length,
          'модель',
          'модели',
          'моделей',
        )}`,
      });
      return;
    }
    const res = await modelsRefresh.refresh();
    // Same auto-select rule: pick the first model if none chosen yet.
    if (res.ok && !model && res.models.length > 0) setModel(res.models[0]);
  };

  const handleDeleteKey = async (): Promise<void> => {
    try {
      await deleteKeyMut.mutateAsync();
      setConfirmDeleteKey(false);
      // Drop any previous success/error status so the empty state
      // («Введите API-ключ…») becomes visible again.
      setStatus(null);
    } catch {
      // error rendered inside ConfirmDialog via its `error` prop.
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

        <main className="w-full flex-1 space-y-6 p-6">
          {/* §2.16.2: benefit-first title instead of the technical «Экран „AI“». */}
          <div>
            <h1 className="text-xl font-bold">Подключение AI</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
              Ключ, модель и base URL для генерации и чата
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr,minmax(320px,420px)]">
            {/* LEFT: connection */}
            <section className="card space-y-5 p-5">
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
                    className="btn btn-secondary flex-none"
                    data-testid="ai-key-toggle"
                    aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? (
                      <EyeOff className="icon" aria-hidden="true" />
                    ) : (
                      <Eye className="icon" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {hasStoredKey ? (
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span
                      className="badge"
                      style={{
                        background: 'var(--color-success-bg)',
                        color: 'var(--color-success-fg)',
                      }}
                      data-testid="ai-key-saved"
                    >
                      <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                      Ключ сохранён
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--color-danger-fg)' }}
                      data-testid="ai-delete-key"
                      disabled={busy}
                      onClick={() => setConfirmDeleteKey(true)}
                    >
                      <Trash2 className="icon-sm" aria-hidden="true" />
                      Удалить ключ
                    </button>
                  </div>
                ) : null}
                <p className="hint mt-1">Ключ хранится локально и не отображается повторно.</p>
              </div>

              {/* Model + «Обновить список» (§2.16.1: refresh is a secondary action) */}
              <div>
                <label className="label" htmlFor="ai-model-select">
                  Модель (для этого проекта)
                </label>
                <div className="flex gap-2">
                  {manualModel || modelOptions.length === 0 ? (
                    <input
                      id="ai-model-select"
                      className="input flex-1"
                      type="text"
                      value={model}
                      placeholder="Напр.: GigaChat-2-Pro"
                      data-testid="ai-model-manual"
                      onChange={(e) => setModel(e.target.value)}
                    />
                  ) : (
                    <select
                      id="ai-model-select"
                      className="input flex-1"
                      data-testid="ai-model-select"
                      value={model}
                      onChange={(e) => {
                        modelsRefresh.clearNotice();
                        setModel(e.target.value);
                      }}
                    >
                      {model.length === 0 ? <option value="">— выберите модель —</option> : null}
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                  <ModelRefreshButton
                    testid="ai-models-refresh"
                    className="btn btn-secondary flex-none"
                    refreshing={modelsRefresh.isFetching}
                    disabled={busy || !keyProvided}
                    label={<span className="hidden sm:inline">Обновить список</span>}
                    onClick={() => void handleRefreshModels()}
                  />
                </div>
                <ModelListNotice testid="ai-models-notice" notice={modelsRefresh.notice} />
                <p className="hint mt-1">
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

              {/* Base URL */}
              <div>
                <label className="label" htmlFor="ai-baseurl-input">
                  Base URL
                </label>
                <input
                  id="ai-baseurl-input"
                  className="input"
                  style={{ fontFamily: 'var(--font-mono)' }}
                  type="text"
                  value={baseURL}
                  data-testid="ai-baseurl-input"
                  onChange={(e) => setBaseURL(e.target.value)}
                />
                <p className="hint mt-1">
                  AI Hub совместим с OpenAI API — достаточно сменить base_url.
                </p>
              </div>

              {/* §2.16.1 the ONE primary button + §2.16.4 status right under it */}
              <div
                className="space-y-2 border-t pt-4"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <BusyButton
                  className="btn btn-primary w-full"
                  busy={saveMut.isPending}
                  busyLabel="Сохраняем…"
                  data-testid="ai-save"
                  disabled={busy}
                  onClick={() => void handleSave()}
                >
                  Сохранить
                </BusyButton>
                <div data-testid="ai-status" aria-live="polite">
                  {status?.kind === 'success' ? (
                    <p
                      className="flex items-center gap-1.5 rounded-lg p-2 text-xs"
                      style={{
                        background: 'var(--color-success-bg)',
                        color: 'var(--color-success-fg)',
                      }}
                      role="status"
                      data-state="success"
                    >
                      <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                      {status.text}
                    </p>
                  ) : status?.kind === 'error' ? (
                    <p
                      className="flex items-start gap-2 rounded-lg p-2 text-xs"
                      style={{
                        background: 'var(--color-danger-bg)',
                        color: 'var(--color-danger-fg)',
                      }}
                      role="alert"
                      data-state="error"
                    >
                      <TriangleAlert size={14} className="mt-px flex-none" aria-hidden="true" />
                      <span>{status.text}</span>
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
              </div>
            </section>

            {/* RIGHT: step-by-step instruction */}
            <section className="card space-y-4 self-start p-5">
              <GroupTitle>Инструкция по подключению</GroupTitle>
              <ol className="space-y-3 text-sm" style={{ color: 'var(--color-text-2)' }}>
                <li className="flex gap-3">
                  <StepNum n={1} />
                  <span>
                    <strong>Авторизация в AI Hub.</strong> Откройте{' '}
                    <a
                      href="https://hub.ai.sbt/"
                      target="_blank"
                      rel="noopener"
                      className="underline"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      hub.ai.sbt
                    </a>
                    , нажмите «Войти» и войдите под персональной учётной записью.
                  </span>
                </li>
                <li className="flex gap-3">
                  <StepNum n={2} />
                  <span>
                    <strong>API-ключ.</strong> Раздел «API-ключи» → «Создать новый ключ» → укажите
                    название (например, «po-portal») → скопируйте ключ и вставьте его в поле слева.
                  </span>
                </li>
                <li className="flex gap-3">
                  <StepNum n={3} />
                  <span>
                    <strong>Base URL.</strong> Значение по умолчанию:{' '}
                    <code className="text-xs" style={{ fontFamily: 'var(--font-mono)' }}>
                      {AI_DEFAULT_BASE_URL}
                    </code>{' '}
                    — менять нужно только для другого шлюза.
                  </span>
                </li>
                <li className="flex gap-3">
                  <StepNum n={4} />
                  <span>
                    <strong>Модель.</strong> Нажмите «Обновить список» и выберите модель — она будет
                    использоваться для генерации описаний и чата этого проекта.
                  </span>
                </li>
                <li className="flex gap-3">
                  <StepNum n={5} />
                  <span>
                    <strong>Сохраните.</strong> Одна кнопка «Сохранить» записывает ключ, модель и
                    base URL; статус появится сразу под ней.
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
            busyLabel="Удаляем…"
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
