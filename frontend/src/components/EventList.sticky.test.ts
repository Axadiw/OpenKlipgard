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

describe('grid scroll chrome CSS', () => {
  it('[WEB-GRID-120] the grid toolbar is sticky at the top', (ctx) => {
    story(ctx, 'Pasek z filtrami jest przyklejony do góry ekranu — inaczej nie mógłby wrócić po przewinięciu w górę.');
    const css: string = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.grid-toolbar\{[^}]*position:sticky[^}]*top:0/);
  });

  it('[WEB-GRID-123] the page keeps room for the fixed bottom bar', (ctx) => {
    story(ctx, 'Dolna belka jest przypięta do dołu ekranu, a strona rezerwuje na nią miejsce, żeby nie zasłaniała stopki.');
    const css: string = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.grid-scroll-bar\{[^}]*position:fixed[^}]*bottom:0/);
    expect(css).toMatch(/body\.grid-scroll-bar-space\{padding-bottom:calc\(36px/);
  });
});
