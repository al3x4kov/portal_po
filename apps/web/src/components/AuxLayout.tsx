import { Link } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';

/** Shared chrome for the secondary screens (New / Import / Open). */
export function AuxLayout({
  children,
  testid,
}: {
  children: React.ReactNode;
  testid?: string;
}): React.ReactElement {
  return (
    <div className="min-h-screen" data-testid={testid}>
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <Link to="/" className="btn btn-ghost" data-testid="aux-back">
          ← Назад
        </Link>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-lg px-4 py-8">{children}</main>
    </div>
  );
}
