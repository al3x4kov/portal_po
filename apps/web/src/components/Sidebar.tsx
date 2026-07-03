import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export interface SidebarProps {
  projectId: string;
  activePage: 'requirements' | 'dashboard';
  onOpenExport: () => void;
  onOpenTasks: () => void;
}

/* ── SVG icons (Lucide-style, 20×20, stroke="currentColor" strokeWidth="2") ── */

function IconGrid(): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function IconBarChart(): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 20V10" />
      <path d="M12 20V4" />
      <path d="M6 20v-6" />
    </svg>
  );
}

function IconDownload(): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconClipboardList(): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  );
}

/* ── Tooltip span shown on hover ── */

const tooltipStyle: React.CSSProperties = {
  position: 'absolute',
  left: 'calc(100% + 8px)',
  top: '50%',
  transform: 'translateY(-50%)',
  background: '#1e293b',
  color: '#f8fafc',
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  zIndex: 101,
};

/* ── Nav button ── */

interface NavBtnProps {
  label: string;
  testId: string;
  active?: boolean;
  hovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  children: React.ReactNode;
}

function NavBtn({
  label,
  testId,
  active = false,
  hovered,
  onMouseEnter,
  onMouseLeave,
  onClick,
  children,
}: NavBtnProps): React.ReactElement {
  const btnStyle: React.CSSProperties = {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    background: active
      ? 'var(--sidebar-active-bg)'
      : hovered
        ? 'var(--sidebar-hover-bg)'
        : 'transparent',
    color: active ? 'var(--sidebar-icon-active)' : 'var(--sidebar-icon)',
    transition: 'background 0.15s, color 0.15s',
  };

  return (
    <button
      type="button"
      style={btnStyle}
      data-testid={testId}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      {hovered && <span style={tooltipStyle}>{label}</span>}
    </button>
  );
}

/* ── Main Sidebar component ── */

export function Sidebar({
  projectId,
  activePage,
  onOpenExport,
  onOpenTasks,
}: SidebarProps): React.ReactElement {
  const navigate = useNavigate();
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: 'var(--sidebar-width)',
    background: 'var(--sidebar-bg)',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '8px 0',
    gap: '4px',
    borderRight: '1px solid rgba(255,255,255,0.08)',
  };

  const logoStyle: React.CSSProperties = {
    width: '40px',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--sidebar-icon-active)',
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: '0.05em',
    marginBottom: '4px',
    userSelect: 'none',
  };

  const dividerStyle: React.CSSProperties = {
    width: '32px',
    height: '1px',
    background: 'rgba(255,255,255,0.15)',
    margin: '4px 0',
  };

  const hover = (id: string) => ({
    onMouseEnter: () => setHoveredBtn(id),
    onMouseLeave: () => setHoveredBtn(null),
  });

  return (
    <nav style={containerStyle} aria-label="Боковая навигация" data-testid="sidebar">
      {/* Logo */}
      <div style={logoStyle} aria-hidden="true">
        PO
      </div>

      {/* Requirements */}
      <NavBtn
        label="Требования"
        testId="sidebar-nav-requirements"
        active={activePage === 'requirements'}
        hovered={hoveredBtn === 'requirements'}
        {...hover('requirements')}
        onClick={() => navigate(`/p/${projectId}`)}
      >
        <IconGrid />
      </NavBtn>

      {/* Dashboard */}
      <NavBtn
        label="Дашборд"
        testId="sidebar-nav-dashboard"
        active={activePage === 'dashboard'}
        hovered={hoveredBtn === 'dashboard'}
        {...hover('dashboard')}
        onClick={() => navigate(`/p/${projectId}/dashboard`)}
      >
        <IconBarChart />
      </NavBtn>

      {/* Divider */}
      <div style={dividerStyle} role="separator" aria-hidden="true" />

      {/* Export */}
      <NavBtn
        label="Экспорт"
        testId="sidebar-open-export"
        hovered={hoveredBtn === 'export'}
        {...hover('export')}
        onClick={onOpenExport}
      >
        <IconDownload />
      </NavBtn>

      {/* Tasks */}
      <NavBtn
        label="Задачи для трекера"
        testId="sidebar-open-tasks"
        hovered={hoveredBtn === 'tasks'}
        {...hover('tasks')}
        onClick={onOpenTasks}
      >
        <IconClipboardList />
      </NavBtn>
    </nav>
  );
}
