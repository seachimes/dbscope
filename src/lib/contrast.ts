/**
 * WCAG 2.x contrast math.
 *
 * Kept as plain functions so the theme can be checked in tests rather than by
 * eye: a color choice that looks fine on one monitor can still be unreadable on
 * another, and the ratio is the only part of that judgement that is objective.
 */

/** Undo sRGB gamma encoding, per WCAG's relative luminance definition. */
function linearize(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex: string): [number, number, number] {
  const body = hex.trim().replace(/^#/, "");
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex color: ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(linearize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two opaque colors, from 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA: 4.5:1 for body text, 3:1 for large text. */
export const meetsBodyText = (ratio: number): boolean => ratio >= 4.5;

/** WCAG 1.4.11: 3:1 for borders and indicators that convey information. */
export const meetsNonText = (ratio: number): boolean => ratio >= 3;
