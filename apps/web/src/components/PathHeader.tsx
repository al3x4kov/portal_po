import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { useToast } from './Toast';

interface PathHeaderProps {
  name: string;
  mainPath: string;
}

/**
 * Sticky top header (new_design §2.9): «← Проекты», dominant project name (h1),
 * secondary 11px mono path that copies itself to the clipboard on click.
 */
export function PathHeader({ name, mainPath }: PathHeaderProps): React.ReactElement {
  const navigate = useNavigate();
  const toast = useToast();

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(mainPath);
      toast.show('Путь скопирован');
    } catch {
      toast.show('Не удалось скопировать путь', 'error');
    }
  };

  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-2 border-b px-3 sm:gap-4 sm:px-6"
      style={{
        height: 'var(--header-height)',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      data-testid="path-header"
    >
      <button
        type="button"
        className="btn btn-ghost btn-sm -ml-1 flex-none"
        data-testid="main-back"
        onClick={() => navigate('/')}
      >
        <ArrowLeft className="icon-sm" aria-hidden="true" />
        Проекты
      </button>
      <div className="min-w-0 flex-1">
        <h1
          className="truncate text-base font-semibold leading-tight sm:text-[17px]"
          data-testid="project-name"
          title={name}
        >
          {name}
        </h1>
        <button
          type="button"
          className="tip-host mono t3 flex min-w-0 max-w-full items-center gap-1.5"
          style={{ fontSize: 'var(--text-min)' }}
          aria-label="Скопировать путь проекта"
          data-testid="copy-path"
          onClick={() => void copyPath()}
        >
          <Copy width={12} height={12} className="flex-none" aria-hidden="true" />
          <span className="truncate" data-testid="main-path" title={mainPath}>
            {mainPath}
          </span>
          <span className="t3 hidden flex-none font-sans sm:inline">· копируется по клику</span>
          <span className="tip tip-below font-sans">Скопировать путь</span>
        </button>
      </div>
      <div className="flex-none">
        <ThemeToggle />
      </div>
    </header>
  );
}
