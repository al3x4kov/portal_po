import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio, parseHex, relativeLuminance } from './contrast';
import { AI_IMPORT_LOG_BG, AI_IMPORT_LOG_LEVEL_COLOR, AI_IMPORT_LOG_TEXT } from './logColors';

describe('contrast helpers', () => {
  it('computes known contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('parses shorthand and full hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#0f172a')).toEqual([15, 23, 42]);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });
});

/** Pull a `--token: value;` out of a CSS block. */
function readToken(css: string, token: string): string {
  const m = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`token ${token} not found`);
  return m[1].trim();
}

function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
}

describe('UX-9 · secondary text token meets WCAG AA (4.5:1)', () => {
  const css = readFileSync(resolve(process.cwd(), 'apps/web/src/index.css'), 'utf8');
  const light = block(css, ':root');
  const dark = block(css, 'html.dark');

  it('light theme --color-text-3 clears 4.5:1 on surface and surface-2', () => {
    const text3 = readToken(light, '--color-text-3');
    expect(contrastRatio(text3, readToken(light, '--color-surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text3, readToken(light, '--color-surface-2'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text3, readToken(light, '--color-bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('dark theme --color-text-3 clears 4.5:1 on surface and surface-2', () => {
    const text3 = readToken(dark, '--color-text-3');
    expect(contrastRatio(text3, readToken(dark, '--color-surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text3, readToken(dark, '--color-surface-2'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text3, readToken(dark, '--color-bg'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('UX-9 · semantic badge/chip text meets WCAG AA (4.5:1)', () => {
  const css = readFileSync(resolve(process.cwd(), 'apps/web/src/index.css'), 'utf8');
  const light = block(css, ':root');
  const dark = block(css, 'html.dark');
  // Every tinted badge/chip/note box pairs `--color-<tone>-fg` text on
  // `--color-<tone>-bg`. The base `--color-<tone>` colours are reserved for
  // solid buttons / dots / focus rings, where the surface is white/dark.
  const tones = ['success', 'warning', 'danger', 'info'] as const;

  for (const tone of tones) {
    it(`light theme --color-${tone}-fg clears 4.5:1 on --color-${tone}-bg`, () => {
      const fg = readToken(light, `--color-${tone}-fg`);
      const bg = readToken(light, `--color-${tone}-bg`);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`dark theme --color-${tone}-fg clears 4.5:1 on --color-${tone}-bg`, () => {
      // Dark overrides both -fg and -bg; fall back to the light -fg only if a
      // tone were left un-overridden (it is not — this guards regressions).
      const fg = readToken(dark, `--color-${tone}-fg`);
      const bg = readToken(dark, `--color-${tone}-bg`);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('a11y (Q-track) · AI-import log colours meet WCAG AA (4.5:1)', () => {
  // The log background is a fixed dark terminal (#0f172a) in BOTH themes, so a
  // single check per colour covers light and dark. axe flagged the old
  // slate-500 timestamps at ≈3.8:1 — this suite pins the fix.
  it('log body text clears 4.5:1 on the log background', () => {
    expect(contrastRatio(AI_IMPORT_LOG_TEXT, AI_IMPORT_LOG_BG)).toBeGreaterThanOrEqual(4.5);
  });

  for (const [level, colour] of Object.entries(AI_IMPORT_LOG_LEVEL_COLOR)) {
    it(`«${level}» timestamp/level colour clears 4.5:1 on the log background`, () => {
      expect(contrastRatio(colour, AI_IMPORT_LOG_BG)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
