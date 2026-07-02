import { useUiStore } from '../store/ui';

export function ThemeToggle(): React.ReactElement {
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const theme = useUiStore((s) => s.theme);
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="btn btn-ghost"
      aria-label="Переключить тему"
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={toggleTheme}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
    >
      {/* UX-10: the glyph reflects the CURRENT theme (moon = dark, sun = light),
          not just the tooltip. */}
      <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
    </button>
  );
}
