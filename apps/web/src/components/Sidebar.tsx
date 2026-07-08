import { useNavigate } from 'react-router-dom';
import {
  BookMarked,
  ChartColumn,
  ClipboardList,
  Download,
  ListTree,
  Sparkle,
  Waypoints,
} from 'lucide-react';
import { useUiStore } from '../store/ui';

export interface SidebarProps {
  projectId: string;
  activePage: 'requirements' | 'dashboard' | 'ai' | 'dictionaries';
  onOpenExport: () => void;
  onOpenTasks: () => void;
}

/* ── Nav item: icon + tooltip on hover AND :focus-visible (new_design §2.8) ── */

interface NavBtnProps {
  label: string;
  testId: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function NavBtn({
  label,
  testId,
  active = false,
  onClick,
  children,
}: NavBtnProps): React.ReactElement {
  return (
    <button
      type="button"
      className="nav-item"
      data-testid={testId}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
      <span className="tip">{label}</span>
    </button>
  );
}

/**
 * Fixed icon sidebar (new_design §2.8): the navigation zone (Требования /
 * Дашборд / Настройка AI / Граф связей) is separated from the actions zone
 * (Экспорт проекта / Генерация задач) by a divider labelled «Действия».
 * The «PO» logo links back to the Start screen.
 */
export function Sidebar({
  projectId,
  activePage,
  onOpenExport,
  onOpenTasks,
}: SidebarProps): React.ReactElement {
  const navigate = useNavigate();
  const graphView = useUiStore((s) => s.graphView);
  const setGraphView = useUiStore((s) => s.setGraphView);

  const goRequirements = (): void => {
    setGraphView(false);
    navigate(`/p/${projectId}`);
  };
  // «Граф связей» switches the existing graph mode of the tree page (no new route).
  const goGraph = (): void => {
    setGraphView(true);
    navigate(`/p/${projectId}`);
  };

  return (
    <nav
      className="fixed inset-y-0 left-0 z-40 flex flex-col items-center gap-1 border-r py-3"
      style={{
        width: 'var(--sidebar-width)',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      aria-label="Основная навигация"
      data-testid="sidebar"
    >
      {/* Логотип PO — ссылка на Start (§2.8) */}
      <button
        type="button"
        className="nav-item mb-2 text-sm font-bold text-white"
        style={{ background: 'var(--color-primary)', color: '#fff' }}
        aria-label="К списку проектов"
        data-testid="sidebar-home"
        onClick={() => navigate('/')}
      >
        PO
        <span className="tip">К списку проектов</span>
      </button>

      {/* Зона НАВИГАЦИИ */}
      <NavBtn
        label="Требования"
        testId="sidebar-nav-requirements"
        active={activePage === 'requirements' && !graphView}
        onClick={goRequirements}
      >
        <ListTree className="icon" aria-hidden="true" />
      </NavBtn>
      <NavBtn
        label="Дашборд"
        testId="sidebar-nav-dashboard"
        active={activePage === 'dashboard'}
        onClick={() => navigate(`/p/${projectId}/dashboard`)}
      >
        <ChartColumn className="icon" aria-hidden="true" />
      </NavBtn>
      <NavBtn
        label="Справочники"
        testId="sidebar-nav-dictionaries"
        active={activePage === 'dictionaries'}
        onClick={() => navigate(`/p/${projectId}/dictionaries`)}
      >
        <BookMarked className="icon" aria-hidden="true" />
      </NavBtn>
      <NavBtn
        label="Настройка AI"
        testId="sidebar-nav-ai"
        active={activePage === 'ai'}
        onClick={() => navigate(`/p/${projectId}/ai`)}
      >
        <Sparkle className="icon" aria-hidden="true" />
      </NavBtn>
      <NavBtn
        label="Граф связей"
        testId="sidebar-nav-graph"
        active={activePage === 'requirements' && graphView}
        onClick={goGraph}
      >
        <Waypoints className="icon" aria-hidden="true" />
      </NavBtn>

      {/* Разделитель: зона ДЕЙСТВИЙ (§2.8 — не смешивать с навигацией) */}
      <div
        className="mb-1 mt-3 w-8 border-t"
        style={{ borderColor: 'var(--color-border)' }}
        role="separator"
        aria-hidden="true"
      />
      <span className="t3 mb-1" style={{ fontSize: 'var(--text-min)' }}>
        Действия
      </span>

      <NavBtn label="Экспорт проекта" testId="sidebar-open-export" onClick={onOpenExport}>
        <Download className="icon" aria-hidden="true" />
      </NavBtn>
      <NavBtn label="Генерация задач" testId="sidebar-open-tasks" onClick={onOpenTasks}>
        <ClipboardList className="icon" aria-hidden="true" />
      </NavBtn>
    </nav>
  );
}
