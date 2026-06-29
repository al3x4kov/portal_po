import { useUiStore } from '../store/ui';

export function ThemeToggle(): React.ReactElement {
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const theme = useUiStore((s) => s.theme);
  return (
    <button
      type="button"
      className="btn btn-ghost"
      aria-label="Переключить тему"
      data-testid="theme-toggle"
      onClick={toggleTheme}
      title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
    >
      ◐
    </button>
  );
}
