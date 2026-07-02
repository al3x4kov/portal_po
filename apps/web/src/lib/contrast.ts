/**
 * WCAG 2.1 relative-luminance / contrast-ratio helpers (UX-9). Used to guard the
 * secondary-text token (`--color-text-3`) against dropping below AA (4.5:1).
 */

/** Parse a `#rrggbb` (or `#rgb`) hex colour into 8-bit RGB channels. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Invalid hex colour: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
