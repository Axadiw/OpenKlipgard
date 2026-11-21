import { describe, expect, it } from 'vitest';
import { cameraBadgeStyle, colorForCamera, textColorOn } from './cameraColors';

const DARK = '#000000';
const WHITE = '#FFFFFF';

describe('textColorOn (WEB-GRID-064)', () => {
  it('puts white text on a dark blue badge', () => {
    expect(textColorOn('hsl(240.0deg 72% 46%)')).toBe(WHITE);
  });

  it('puts dark text on a light yellow badge', () => {
    expect(textColorOn('hsl(55.0deg 72% 58%)')).toBe(DARK);
  });

  it('keeps the theme text when the colour is unknown or not from the palette', () => {
    expect(textColorOn(undefined)).toBeUndefined();
    expect(textColorOn('var(--accent)')).toBeUndefined();
  });

  it('reaches WCAG AA text contrast (4.5:1) for every palette colour of many names', () => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const hexLum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Independent HSL → RGB via the canvas-free formula, to cross-check the helper.
    const hslLum = (color: string) => {
      const [, h, s, l] = /hsl\(([\d.]+)deg (\d+)% (\d+)%\)/.exec(color)!.map(Number);
      const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
    };
    const ratio = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    for (let i = 0; i < 500; i++) {
      const bg = colorForCamera(`Camera ${i}`);
      const fg = textColorOn(bg)!;
      expect(ratio(hslLum(bg), hexLum(fg))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('cameraBadgeStyle', () => {
  it('returns the background with a readable text colour', () => {
    expect(cameraBadgeStyle('hsl(240.0deg 72% 46%)')).toEqual({ background: 'hsl(240.0deg 72% 46%)', color: WHITE });
  });

  it('returns no inline style without a colour, so the CSS default applies', () => {
    expect(cameraBadgeStyle(undefined)).toEqual({});
  });
});
