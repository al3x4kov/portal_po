import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';

interface PathHeaderProps {
  name: string;
  mainPath: string;
}

/** Sticky top header: back, project name, Main Path (FR-5.1), theme toggle. */
export function PathHeader({ name, mainPath }: PathHeaderProps): React.ReactElement {
  const navigate = useNavigate();
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
