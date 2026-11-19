// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { createHash } from 'node:crypto';
import nginxConf from '../../nginx.conf?raw';
import nginxCloudConf from '../../nginx.cloud.conf?raw';
import indexHtml from '../index.html?raw';

// [WEB-SHELL-001] [WEB-SHELL-075] [WEB-SHELL-076] [WEB-SHELL-077] [WEB-SHELL-078]
// The boot overlay and the boot splash show the Klipgard mark with the focus
// motion and, for a long load, the breathe loop, CSS only, before the bundle runs.

const style = /<style>([\s\S]*?)<\/style>/.exec(indexHtml)?.[1] ?? '';

describe('boot splash in index.html [WEB-SHELL-075]', () => {
  it('puts the mark inside #root, so React replaces it on its first render', () => {
    expect(indexHtml).toMatch(/<div id="root"><div class="kg-boot" aria-hidden="true"><svg viewBox="0 0 1024 1024"/);
  });

  it('keeps a template of the same mark for the boot overlay [WEB-SHELL-001]', () => {
    const tpl = /<template id="kg-boot-mark">([\s\S]*?)<\/template>/.exec(indexHtml)?.[1];
    const root = /<div id="root"><div class="kg-boot" aria-hidden="true">([\s\S]*?)<\/div><\/div>/.exec(indexHtml)?.[1];
    expect(tpl).toBeTruthy();
    expect(tpl).toBe(root);
    // Four corners, clockwise from the top left, and the K.
    expect(tpl!.match(/class="kg-c kg-(tl|tr|br|bl)"/g)).toEqual([
      'class="kg-c kg-tl"', 'class="kg-c kg-tr"', 'class="kg-c kg-br"', 'class="kg-c kg-bl"',
    ]);
    expect(tpl!.match(/class="kg-k"/g)).toHaveLength(1);
    // The overlay script clones it; no spinner is left.
    expect(indexHtml).toContain("document.getElementById('kg-boot-mark')");
    expect(indexHtml).not.toContain('boot-spinner');
  });

  it('[WEB-SHELL-075] draws the corners of the brand book: outer radius 82, inner radius 27', () => {
    const tpl = /<template id="kg-boot-mark">([\s\S]*?)<\/template>/.exec(indexHtml)![1];
    const corners = [...tpl.matchAll(/class="kg-c [\w-]+" d="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(corners)).toEqual(new Set(['M146 346V228A82 82 0 0 1 228 146H346V200H227A27 27 0 0 0 200 227V346Z']));
    expect(tpl).toContain('d="M312 294H416V495L601 294H727L533 505.5L729 730H600L416 521V730H312Z"');
  });

  it('[WEB-SHELL-076] animates only transform, opacity and filter, with the focus timing of CLIENT-AUTH-062', () => {
    const keyframes = [...style.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\}\s*\}/g)].map((m) => m[1]);
    expect(keyframes.length).toBe(4);
    for (const k of keyframes) {
      const props = [...k.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(['transform', 'opacity', 'filter']).toContain(p);
    }
    // Corners: 0-700 ms after the 150 ms delay, from 90 out at .15, 8 overshoot at 60 %.
    expect(style).toContain('animation: kg-in .7s cubic-bezier(.2,.9,.25,1.15) .15s both,');
    expect(style).toMatch(/0% \{ transform: translate\(-90px,-90px\); opacity: \.15; \}\s*60% \{ transform: translate\(8px,8px\); opacity: 1; \}/);
    // K: 300-900 ms, ease-out, from opacity .35, scale .94 and a 6 px blur to sharp.
    expect(style).toContain('animation: kg-k .6s ease-out .45s both;');
    expect(style).toMatch(/from \{ opacity: \.35; transform: scale\(\.94\); filter: blur\(6px\); \}\s*to \{ opacity: 1; transform: none; filter: none; \}/);
  });

  it('[WEB-SHELL-077] loops the breathe motion on the corners only, from the end of the focus, 100 ms apart clockwise', () => {
    expect(style).toContain('kg-breathe 1.6s ease-in-out 1.05s infinite;');
    expect(style).toMatch(/@keyframes kg-breathe \{ 0%, 100% \{ transform: none; opacity: 1; \}\s*50% \{ transform: scale\(\.82\); opacity: \.55; \} \}/);
    expect(style).toContain('.kg-boot .kg-tr { animation-delay: .15s, 1.15s; }');
    expect(style).toContain('.kg-boot .kg-br { animation-delay: .15s, 1.25s; }');
    expect(style).toContain('.kg-boot .kg-bl { animation-delay: .15s, 1.35s; }');
    // Scales towards the centre of the mark; the K never loops.
    expect(style).toMatch(/\.kg-boot \.kg-c \{[^}]*transform-origin: 512px 512px;/);
    expect(/\.kg-boot \.kg-k \{([^}]*)\}/.exec(style)![1]).not.toMatch(/infinite/);
    expect(style.match(/infinite/g)).toHaveLength(1);
  });

  it('shows the mark only after 150 ms, so a fast boot never flashes it', () => {
    expect(style).toMatch(/\.kg-boot svg \{[^}]*opacity: 0;[^}]*animation: kg-show \.2s ease-out \.15s forwards;/);
  });

  it('[WEB-SHELL-078] shows the static mark, with no focus and no breathe, when the visitor asks for reduced motion', () => {
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.kg-boot svg, \.kg-boot \.kg-c, \.kg-boot \.kg-k \{ animation: none; opacity: 1; transform: none; \}/);
  });
});

describe.each([['nginx.conf', nginxConf], ['nginx.cloud.conf', nginxCloudConf]])('%s CSP', (_name, conf) => {
  it('script-src allows the hash of every inline script index.html runs', () => {
    const inline = [...indexHtml.matchAll(/<script(?![^>]*\b(?:src|type)=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline.length).toBeGreaterThan(0);
    const lines = conf.split('\n').filter((l) => l.includes('add_header Content-Security-Policy'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const s of inline) {
      const h = `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
      for (const line of lines) expect(line).toContain(h);
    }
  });
});
