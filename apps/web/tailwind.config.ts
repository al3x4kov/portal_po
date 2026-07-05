import type { Config } from 'tailwindcss';

/**
 * Design tokens mirrored from uiux/tokens.css. Concrete values live as CSS
 * custom properties in src/index.css (light :root + html.dark overrides); here
 * we expose them to Tailwind via var() so the `dark` class swaps the palette.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          soft: 'var(--color-primary-soft)',
        },
        accent: 'var(--color-accent)',
        bg: 'var(--color-bg)',
        surface: {
          DEFAULT: 'var(--color-surface)',
          2: 'var(--color-surface-2)',
        },
        border: 'var(--color-border)',
        text: {
          DEFAULT: 'var(--color-text)',
          2: 'var(--color-text-2)',
          3: 'var(--color-text-3)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
          bg: 'var(--color-success-bg)',
          fg: 'var(--color-success-fg)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          bg: 'var(--color-warning-bg)',
          fg: 'var(--color-warning-fg)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          bg: 'var(--color-danger-bg)',
          fg: 'var(--color-danger-fg)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
          bg: 'var(--color-info-bg)',
          fg: 'var(--color-info-fg)',
        },
        crit: {
          low: 'var(--crit-low)',
          medium: 'var(--crit-medium)',
          high: 'var(--crit-high)',
          critical: 'var(--crit-critical)',
          blocker: 'var(--crit-blocker)',
        },
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        /* text-min → минимальный кегль UI (11px, --text-min). */
        min: ['var(--text-min)', { lineHeight: '1.35' }],
      },
      spacing: {
        /* Layout-константы: h-header, w-sidebar, bottom-toast-offset. */
        header: 'var(--header-height)',
        sidebar: 'var(--sidebar-width)',
        'toast-offset': 'var(--toast-offset)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
    },
  },
  plugins: [],
};

export default config;
