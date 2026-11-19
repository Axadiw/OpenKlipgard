// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';

const css: string = readFileSync(new URL('./KlipgardLoader.css', import.meta.url), 'utf8');

describe('KlipgardLoader CSS', () => {
  it('breathes: 1.6 s ease-in-out, scale .82 and opacity .55 about the mark centre, corners 100 ms apart', () => {
    expect(css).toMatch(/\.kg-loader-c\{transform-box:view-box;transform-origin:512px 512px;animation:kg-loader-breathe 1\.6s ease-in-out infinite\}/);
    expect(css).toMatch(/@keyframes kg-loader-breathe\{0%,100%\{transform:scale\(1\);opacity:1\}50%\{transform:scale\(\.82\);opacity:\.55\}\}/);
    expect(css).toContain('.kg-loader-c2{animation-delay:.1s}');
    expect(css).toContain('.kg-loader-c3{animation-delay:.2s}');
    expect(css).toContain('.kg-loader-c4{animation-delay:.3s}');
  });

  it('with reduced motion the corners stand still and the whole loader fades in 2.4 s', () => {
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
    expect(rm).toContain('.kg-loader-c{animation:none}');
    expect(rm).toContain('.kg-loader{animation:kg-loader-fade 2.4s ease-in-out infinite}');
  });

  it('uses the brand colours on dark and on light', () => {
    expect(css).toContain('.kg-loader-corners{fill:#6EE7B7}');
    expect(css).toContain('.kg-loader-k{fill:#E4F8ED}');
    expect(css).toContain('[data-theme="light"] .kg-loader-corners{fill:#047857}');
    expect(css).toContain('[data-theme="light"] .kg-loader-k{fill:#1F2937}');
  });
});
