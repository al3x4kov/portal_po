import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';

interface PathHeaderProps {
  name: string;
  mainPath: string;
  /** Optional project id — when present, renders in-project nav tabs. */
  projectId?: string;
  /** Which tab is currently active: 'requirements' (default) or 'dashboard'. */
  activePage?: 'requirements' | 'dashboard';
}

/** Sticky top header: back, project name, Main Path (FR-5.1), nav tabs, theme toggle. */
export function PathHeader({
  name,
  mainPath,
  projectId,
  activePage = 'requirements',
}: PathHeaderProps): React.ReactElement {
  const navigate = useNavigate();

  const tab = (
    label: string,
    page: 'requirements' | 'dashboard',
    path: string,
    testid: string,
  ): React.ReactElement => {
    const active = activePage === page;
    return (
      <button
        key={page}
        type="button"
        className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
        style={
          active
            ? {
                background: 'var(--color-primary-soft)',
                color: 'var(--color-primary)',
              }
            : { color: 'var(--color-text-2)' }
        }
        data-testid={testid}
        onClick={() => navigate(path)}
        aria-current={active ? 'page' : undefined}
      >
        {label}
      </button>
    );
  };

  return (
    <header
      className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b px-4 py-3"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="path-header"
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Назад"
          data-testid="main-back"
          onClick={() => navigate('/')}
        >
          ←
        </button>
        <div className="min-w-0">
          <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Main Path
          </div>
          <div className="truncate font-mono text-sm" data-testid="main-path" title={mainPath}>
            {mainPath}
          </div>
        </div>
        {projectId ? (
          <nav className="flex items-center gap-1" aria-label="Навигация по проекту">
            {tab('Требования', 'requirements', `/p/${projectId}`, 'nav-requirements')}
            {tab('Дашборд', 'dashboard', `/p/${projectId}/dashboard`, 'nav-dashboard')}
          </nav>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span
          className="hidden truncate text-sm font-semibold sm:inline"
          data-testid="project-name"
        >
          {name}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
