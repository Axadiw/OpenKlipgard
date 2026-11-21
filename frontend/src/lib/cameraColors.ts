/**
 * Deterministic per-camera colour — a PURE FUNCTION of the camera NAME.
 *
 * Each camera's colour depends ONLY on its own name (three independent djb2
 * hashes, seeds 5381 / 7919 / 104729), never on the rest of the set. This is
 * the single source of truth shared byte-for-byte with iOS / macOS / tvOS /
 * Windows / Android (`CameraPalette.{swift,cs,kt}`).
 *
 * Stability properties:
 *   - A camera keeps the exact same colour everywhere and across sessions.
 *   - Adding or removing a camera NEVER changes any other camera's colour.
 *   - hue = djb2(name, 5381) mod 360; saturation cycles 58/65/72 via
 *     djb2(name, 7919) mod 3; lightness alternates 46/58 via
 *     djb2(name, 104729) mod 2 — enough variation to keep dense 30–50 camera
 *     timelines legible, all combos ≥46% light / ≥58% sat for solid contrast
 *     on the white timeline and the dark admin storage bars alike.
 */

/** 32-bit djb2 over the name's UTF-16 code units (`|0` = wrap to int32). */
function djb2(name: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return h;
}

const mod = (x: number, n: number): number => ((x % n) + n) % n;

/** The canonical colour for a single camera name. */
export function colorForCamera(name: string): string {
  const hue = mod(djb2(name, 5381), 360);
  const sat = 58 + mod(djb2(name, 7919), 3) * 7; // 58 / 65 / 72
  const light = 46 + mod(djb2(name, 104729), 2) * 12; // 46 / 58
  return `hsl(${hue.toFixed(1)}deg ${sat}% ${light}%)`;
}

/** Convenience: a name→colour map for a set of cameras (each independent). */
export function paletteForCameras(cameras: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cam of new Set(cameras)) map.set(cam, colorForCamera(cam));
  return map;
}

const DARK_TEXT = '#000000';
const LIGHT_TEXT = '#FFFFFF';

/** sRGB channel (0..1) → linear, per WCAG 2.x relative luminance. */
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Relative luminance of an `hsl(<h>deg <s>% <l>%)` string from colorForCamera; null if it does not parse. */
function luminanceOfHsl(color: string): number | null {
  const m = /^hsl\(\s*([\d.]+)deg\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(color.trim());
  if (!m) return null;
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const [r, g, b] = [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const DARK_L = 0; // relative luminance of #000000: with white, one of the two always reaches 4.58:1
const LIGHT_L = 1;

/**
 * Text colour for a label drawn on a camera colour: near-black or white,
 * whichever has the higher WCAG contrast ratio against the background
 * (WEB-GRID-064). Undefined when the colour is unknown, so the badge keeps
 * the theme's `--on-accent`.
 */
export function textColorOn(background: string | undefined): string | undefined {
  if (!background) return undefined;
  const lum = luminanceOfHsl(background);
  if (lum == null) return undefined;
  return contrast(lum, DARK_L) >= contrast(lum, LIGHT_L) ? DARK_TEXT : LIGHT_TEXT;
}

/** Inline style for a camera badge: the palette colour plus readable text. */
export function cameraBadgeStyle(background: string | undefined): { background?: string; color?: string } {
  return background ? { background, color: textColorOn(background) } : {};
}
