import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

/**
 * Shared chrome for the secondary screens (New / Import / Open):
 * sticky header with a ghost «Назад» button and the screen title,
 * centered max-w-2xl content column (new_design/screens/*.html).
 */
export function AuxLayout({
  children,
  title,
  testid,
}: {
  children: React.ReactNode;
  /** Screen title shown next to the back button (e.g. «Новый проект»). */
  title?: string;
  testid?: string;
}): React.ReactElement {
  return (
    <div className="min-h-screen" data-testid={testid}>
      <header
        className="sticky top-0 z-10 flex h-header items-center gap-3 border-b px-4 sm:px-6"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <Link to="/" className="btn btn-ghost btn-sm" data-testid="aux-back">
          <ArrowLeft className="icon-sm" aria-hidden="true" />
          Назад
        </Link>
        {title ? <h1 className="text-base font-semibold">{title}</h1> : null}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 pb-24 sm:px-6">{children}</main>
    </div>
  );
}
