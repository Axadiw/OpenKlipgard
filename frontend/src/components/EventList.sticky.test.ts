// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';
import { story } from '../test-story';

describe('EventList current-day bar CSS', () => {
  it('[WEB-GRID-059] pins the bar to the top of the viewport with sticky positioning', (ctx) => {
    story(ctx, 'Belka aktualnego dnia ma realne przypięcie CSS (position: sticky; top: 0) — bez tego znikałaby razem z przewijaną stroną.');
    const css: string = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.current-day-slot\{[^}]*position:sticky[^}]*top:0/);
  });
});
