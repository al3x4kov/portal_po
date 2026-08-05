import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';

export interface WorkspaceScreenProps {
  projectId: string;
  /** Подсвеченное действие в сайдбаре: экспорт или генерация. */
  action: 'export' | 'tasks';
  /** Заголовок экрана: «Экспорт проекта · Twitter». */
  title: string;
  /** Путь проекта на диске — вторая строка шапки. */
  mainPath: string;
  /** Левая колонка футера (обычно «Назад»/«Закрыть»). */
  footerLeft?: React.ReactNode;
  /** Правая колонка футера (действия: скачать, перегенерировать). */
  footerRight?: React.ReactNode;
  children: React.ReactNode;
  testid?: string;
  /**
   * Перехват ухода с экрана (кнопка «Требования», сайдбар, Esc). Возвращает
   * `false`, если уходить нельзя прямо сейчас — экран сам показывает
   * подтверждение (макет Г11: прерывание идущей AI-генерации).
   */
  onBeforeLeave?: () => boolean;
}

/**
 * Каркас полноэкранного рабочего режима (экспорт, генерация артефактов).
 *
 * Повторяет хром основного экрана требований — фиксированный сайдбар слева и
 * sticky-шапка с «← Требования», именем и путём проекта, — потому что экспорт
 * и генерация перестали быть модалками: это отдельные маршруты, где выбор,
 * параметры, журнал прогона и результат должны помещаться одновременно
 * (макеты docs/design/screens/flow-*.html). Из сайдбара по-прежнему доступна
 * вся навигация: пользователь не заперт в «окне».
 */
export function WorkspaceScreen({
  projectId,
  action,
  title,
  mainPath,
  footerLeft,
  footerRight,
  children,
  testid,
  onBeforeLeave,
}: WorkspaceScreenProps): React.ReactElement {
  const navigate = useNavigate();
  /** Уйти по адресу, если экран разрешает (иначе он покажет подтверждение). */
  const leaveTo = (path: string): void => {
    if (onBeforeLeave && !onBeforeLeave()) return;
    navigate(path);
  };
  const goRequirements = (): void => leaveTo(`/p/${projectId}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') goRequirements();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="min-h-screen" data-testid={testid}>
      <Sidebar
        projectId={projectId}
        activePage="none"
        activeAction={action}
        {...(onBeforeLeave ? { guard: onBeforeLeave } : {})}
        onOpenExport={() => leaveTo(`/p/${projectId}/export`)}
        onOpenTasks={() => leaveTo(`/p/${projectId}/generate`)}
      />
      <div
        className="flex h-screen flex-col"
        style={{ marginLeft: 'var(--sidebar-width)' }}
        data-testid="workspace-body"
      >
        <header
          className="flex flex-none items-center gap-2 border-b px-3 sm:gap-4 sm:px-6"
          style={{
            height: 'var(--header-height)',
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
          data-testid="workspace-header"
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm -ml-1 flex-none"
            data-testid="workspace-back"
            onClick={goRequirements}
          >
            <ArrowLeft className="icon-sm" aria-hidden="true" />
            Требования
          </button>
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-base font-semibold leading-tight sm:text-[17px]"
              data-testid="workspace-title"
              title={title}
            >
              {title}
            </h1>
            <p
              className="mono t3 truncate"
              style={{ fontSize: 'var(--text-min)' }}
              title={mainPath}
              data-testid="workspace-path"
            >
              {mainPath}
            </p>
          </div>
          <div className="flex-none">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex min-h-0 flex-1 overflow-hidden">{children}</main>

        {footerLeft || footerRight ? (
          <footer
            className="flex flex-none items-center justify-between gap-3 border-t px-6 py-3"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            data-testid="workspace-footer"
          >
            <div className="flex items-center gap-3">{footerLeft}</div>
            <div className="flex items-center gap-3">{footerRight}</div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Правая панель-итог полноэкранного режима (формат/параметры/журнал). */
export function WorkspaceAside({
  children,
  testid,
  width = 460,
}: {
  children: React.ReactNode;
  testid?: string;
  width?: number;
}): React.ReactElement {
  return (
    <aside
      className="flex flex-none flex-col gap-4 overflow-y-auto border-l p-5"
      style={{
        width,
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      data-testid={testid}
    >
      {children}
    </aside>
  );
}

/**
 * Блок действий правой панели: прилипает к низу, чтобы кнопка запуска
 * оставалась на экране, когда параметры длиннее панели (макеты Э1/Г4 —
 * «кнопка действия всегда видна»).
 */
export function AsideActions({
  children,
  testid,
}: {
  children: React.ReactNode;
  testid?: string;
}): React.ReactElement {
  return (
    <div
      className="sticky bottom-0 mt-auto flex flex-col gap-2 pt-3"
      style={{ background: 'var(--color-surface)' }}
      data-testid={testid}
    >
      {children}
    </div>
  );
}

/** Заголовок секции правой панели. */
export function AsideTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <h2
      className="text-xs font-semibold uppercase tracking-wide"
      style={{ color: 'var(--color-text-3)' }}
    >
      {children}
    </h2>
  );
}

/** Цветная плашка-баннер: подсказка, предупреждение или ошибка. */
export function Banner({
  tone,
  children,
  testid,
  role,
}: {
  tone: 'info' | 'warning' | 'danger';
  children: React.ReactNode;
  testid?: string;
  role?: 'alert' | 'status';
}): React.ReactElement {
  const bg = `var(--color-${tone === 'warning' ? 'warning' : tone === 'danger' ? 'danger' : 'info'}-bg)`;
  const fg = `var(--color-${tone === 'warning' ? 'warning' : tone === 'danger' ? 'danger' : 'info'}-fg)`;
  return (
    <p
      className="rounded-lg p-3 text-xs leading-relaxed"
      style={{ background: bg, color: fg }}
      data-testid={testid}
      {...(role ? { role } : {})}
    >
      {children}
    </p>
  );
}
