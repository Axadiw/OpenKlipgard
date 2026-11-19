// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';
import { MARK_ASPECT } from './KlipgardLogo';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const indexCss = read('../index.css');

describe('logo CSS', () => {
  it('[WEB-SHELL-069] colours follow the theme: the dark and light values of the brand book', () => {
    const block = (sel: string) => indexCss.slice(indexCss.indexOf(`${sel}{`)).split('}')[0];
    const dark = block(':root,[data-theme="dark"]');
    const light = block('[data-theme="light"]');
    expect(dark).toContain('--brand-video:#6EE7B7;--logo-k:#E4F8ED;--logo-lip:#E6E9F0;');
    expect(light).toContain('--brand-video:#047857;--logo-k:#1F2937;--logo-lip:#1F2937;');
    expect(indexCss).toContain('.klipgard-logo .kl-frame,.klipgard-logo .kl-gard{fill:var(--brand-video,#6EE7B7)}');
    expect(indexCss).toContain('.klipgard-logo .kl-k{fill:var(--logo-k,#E4F8ED)}');
    expect(indexCss).toContain('.klipgard-logo .kl-lip{fill:var(--logo-lip,#E6E9F0)}');
  });

  it('[WEB-SHELL-015] at 720 px and below the header keeps only the mark: the frame width at the logo height', () => {
    expect(MARK_ASPECT).toBeCloseTo(171.79 / 167.89, 3);
    const narrow = indexCss.slice(indexCss.indexOf('@media(max-width:720px){'));
    expect(narrow).toContain(`.header-title .klipgard-logo{width:calc(28px * ${MARK_ASPECT.toFixed(4)})}`);
    expect(narrow).toContain('.header-title .klipgard-logo .kl-lip,.header-title .klipgard-logo .kl-gard{display:none}');
  });
});
