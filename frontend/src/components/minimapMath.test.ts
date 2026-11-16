import { describe, it, expect } from 'vitest';
import { story } from '../test-story';
import {
  DAY_MS, HOUR_MS, MIN_WINDOW_MS, MAX_WINDOW_MS, spanEndingOn, minimapSpan, densityBins, binCount, dailyBins, binMs,
  timeToX, xToTime, rectPx, hitTest, centreWindow, dragWindow, keyboardWindow, sliderValue,
} from './minimapMath';

const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
const SPAN = { start: D('2026-11-06'), end: D('2026-11-13') };

describe('minimap span', () => {
  it('ends on the day of the given instant and covers 7 whole days', (ctx) => {
    story(ctx, 'Zakres minimapy to 7 pełnych dób zakończonych dniem podanego momentu.');
    const s = spanEndingOn(Date.parse('2026-11-12T13:45:00Z'));
    expect(s).toEqual({ start: D('2026-11-06'), end: D('2026-11-13') });
    expect(s.end - s.start).toBe(7 * DAY_MS);
  });

  it('prefers the 7 days ending today when the window is inside them', (ctx) => {
    story(ctx, 'Gdy okno mieści się w 7 dniach kończących się dzisiaj, minimapa pokazuje te 7 dni.');
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(minimapSpan(null, D('2026-11-10'), D('2026-11-11'), now)).toEqual(SPAN);
  });

  it('falls back to the 7 days ending on the window end day', (ctx) => {
    story(ctx, 'Dla starego okna zakres kończy się w dniu końca okna; pełnodniowe okno nie wciąga następnego dnia.');
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(minimapSpan(null, D('2026-10-01'), D('2026-10-02'), now)).toEqual({ start: D('2026-09-25'), end: D('2026-10-02') });
  });

  it('handles a window that ends after today', (ctx) => {
    story(ctx, 'Okno w przyszłości przesuwa zakres na dzień końca okna.');
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(minimapSpan(null, D('2026-11-14'), D('2026-11-15'), now).end).toBe(D('2026-11-15'));
  });

  it('keeps the previous span while the window stays inside it', (ctx) => {
    story(ctx, 'Przesuwanie okna w obrębie zakresu nie przesuwa samego zakresu.');
    const prev = { start: D('2026-09-26'), end: D('2026-10-03') };
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(minimapSpan(prev, D('2026-09-28'), D('2026-09-29'), now)).toBe(prev);
    expect(minimapSpan(prev, D('2026-10-02'), D('2026-10-04'), now)).not.toBe(prev);
  });

  it('works while now is unknown', (ctx) => {
    story(ctx, 'Bez znanego "teraz" zakres wynika z okna.');
    expect(minimapSpan(null, D('2026-11-12'), D('2026-11-13'), 0)).toEqual(SPAN);
  });
});

describe('minimap bins and mapping', () => {
  it('counts events in the hour of their start and ignores events outside the span', (ctx) => {
    story(ctx, 'Zdarzenia są liczone w godzinie startu; poza zakresem są pomijane.');
    const { bins, max } = densityBins([
      SPAN.start, SPAN.start + 10 * 60_000, SPAN.start + HOUR_MS, SPAN.end - 1, SPAN.end, SPAN.start - 1,
    ], SPAN);
    expect(bins.length).toBe(168);
    expect(bins[0]).toBe(2);
    expect(bins[1]).toBe(1);
    expect(bins[167]).toBe(1);
    expect(max).toBe(2);
  });

  it('maps time and x both ways', (ctx) => {
    story(ctx, 'Mapowanie czas-piksel jest odwracalne i liniowe.');
    expect(timeToX(SPAN.start, SPAN, 700)).toBe(0);
    expect(timeToX(SPAN.end, SPAN, 700)).toBe(700);
    expect(xToTime(350, SPAN, 700)).toBe(SPAN.start + 3.5 * DAY_MS);
    expect(xToTime(1, SPAN, 0)).toBe(SPAN.start);
  });

  it('keeps the rectangle at least 10 px wide and inside the strip', (ctx) => {
    story(ctx, 'Prostokąt okna ma min. 10 px i nie wychodzi poza pasek.');
    expect(rectPx({ viewStart: SPAN.start, viewEnd: SPAN.start + MIN_WINDOW_MS }, SPAN, 700)).toEqual({ x0: 0, x1: 10 });
    expect(rectPx({ viewStart: SPAN.end - MIN_WINDOW_MS, viewEnd: SPAN.end }, SPAN, 700)).toEqual({ x0: 690, x1: 700 });
    expect(rectPx({ viewStart: SPAN.start + DAY_MS, viewEnd: SPAN.start + 2 * DAY_MS }, SPAN, 700)).toEqual({ x0: 100, x1: 200 });
  });
});

describe('minimap hit test', () => {
  it('finds grips, body and outside', (ctx) => {
    story(ctx, 'Chwyt krawędzi, korpus i obszar poza prostokątem są rozróżniane.');
    expect(hitTest(100, 100, 200, 6)).toBe('left');
    expect(hitTest(95, 100, 200, 6)).toBe('left');
    expect(hitTest(206, 100, 200, 6)).toBe('right');
    expect(hitTest(150, 100, 200, 6)).toBe('body');
    expect(hitTest(50, 100, 200, 6)).toBe('outside');
    expect(hitTest(260, 100, 200, 6)).toBe('outside');
  });

  it('leaves a body in a narrow rectangle', (ctx) => {
    story(ctx, 'W wąskim prostokącie krawędzie zajmują najwyżej po jednej trzeciej, więc korpus nadal istnieje.');
    expect(hitTest(105, 100, 110, 12)).toBe('body');
    expect(hitTest(101, 100, 110, 12)).toBe('left');
    expect(hitTest(109, 100, 110, 12)).toBe('right');
  });
});

describe('minimap drag', () => {
  const win = { viewStart: SPAN.start + 2 * DAY_MS, viewEnd: SPAN.start + 3 * DAY_MS };

  it('pans 1:1 and clamps to the span', (ctx) => {
    story(ctx, 'Przeciągnięcie korpusu przesuwa okno 1:1, bez wyjścia poza zakres.');
    expect(dragWindow('pan', win, 3 * HOUR_MS, SPAN)).toEqual({ viewStart: win.viewStart + 3 * HOUR_MS, viewEnd: win.viewEnd + 3 * HOUR_MS });
    expect(dragWindow('pan', win, -10 * DAY_MS, SPAN)).toEqual({ viewStart: SPAN.start, viewEnd: SPAN.start + DAY_MS });
    expect(dragWindow('pan', win, 10 * DAY_MS, SPAN)).toEqual({ viewStart: SPAN.end - DAY_MS, viewEnd: SPAN.end });
  });

  it('moves the left grip and keeps the end fixed, within the length limits', (ctx) => {
    story(ctx, 'Lewy uchwyt zmienia początek okna, koniec stoi; długość mieści się w 2 min..7 dni.');
    expect(dragWindow('left', win, -6 * HOUR_MS, SPAN)).toEqual({ viewStart: win.viewStart - 6 * HOUR_MS, viewEnd: win.viewEnd });
    const squeezed = dragWindow('left', win, 5 * DAY_MS, SPAN);
    expect(squeezed.viewEnd - squeezed.viewStart).toBe(MIN_WINDOW_MS);
    expect(dragWindow('left', win, -50 * DAY_MS, SPAN).viewStart).toBe(SPAN.start);
  });

  it('moves the right grip and keeps the start fixed, within the limits', (ctx) => {
    story(ctx, 'Prawy uchwyt zmienia koniec okna, początek stoi.');
    expect(dragWindow('right', win, 2 * HOUR_MS, SPAN)).toEqual({ viewStart: win.viewStart, viewEnd: win.viewEnd + 2 * HOUR_MS });
    expect(dragWindow('right', win, -50 * DAY_MS, SPAN).viewEnd - win.viewStart).toBe(MIN_WINDOW_MS);
    expect(dragWindow('right', win, 50 * DAY_MS, SPAN).viewEnd).toBe(SPAN.end);
    const first = { viewStart: SPAN.start, viewEnd: SPAN.start + DAY_MS };
    expect(dragWindow('right', first, 50 * DAY_MS, SPAN).viewEnd - SPAN.start).toBeLessThanOrEqual(MAX_WINDOW_MS);
  });

  it('centres the window on a pressed time', (ctx) => {
    story(ctx, 'Kliknięcie poza prostokątem centruje okno w tym miejscu (z zachowaniem długości i zakresu).');
    const t = SPAN.start + 5 * DAY_MS;
    expect(centreWindow(t, win, SPAN)).toEqual({ viewStart: t - DAY_MS / 2, viewEnd: t + DAY_MS / 2 });
    expect(centreWindow(SPAN.start, win, SPAN).viewStart).toBe(SPAN.start);
    expect(centreWindow(SPAN.end, win, SPAN).viewEnd).toBe(SPAN.end);
  });
});

describe('minimap keyboard and slider value', () => {
  const win = { viewStart: SPAN.start + 2 * DAY_MS, viewEnd: SPAN.start + 3 * DAY_MS };

  it('moves by a tenth of the window, a whole window with Shift, and to the ends', (ctx) => {
    story(ctx, 'Strzałki przesuwają okno o 10%, Shift o całe okno, Home/End na początek/koniec zakresu.');
    expect(keyboardWindow('ArrowRight', false, win, SPAN)).toEqual({ viewStart: win.viewStart + DAY_MS / 10, viewEnd: win.viewEnd + DAY_MS / 10 });
    expect(keyboardWindow('ArrowLeft', true, win, SPAN)).toEqual({ viewStart: SPAN.start + DAY_MS, viewEnd: SPAN.start + 2 * DAY_MS });
    expect(keyboardWindow('Home', false, win, SPAN)).toEqual({ viewStart: SPAN.start, viewEnd: SPAN.start + DAY_MS });
    expect(keyboardWindow('End', false, win, SPAN)).toEqual({ viewStart: SPAN.end - DAY_MS, viewEnd: SPAN.end });
    expect(keyboardWindow('ArrowUp', false, win, SPAN)).toBeNull();
  });

  it('reports the slider value in seconds from the span start', (ctx) => {
    story(ctx, 'Wartość slidera to początek okna w sekundach od początku zakresu, max = zakres − okno.');
    expect(sliderValue(win, SPAN)).toEqual({ min: 0, max: 6 * 86400, now: 2 * 86400 });
    expect(sliderValue({ viewStart: SPAN.start - DAY_MS, viewEnd: SPAN.start }, SPAN).now).toBe(0);
  });
});

describe('minimapSpan keeps the same object when nothing changes [WEB-TIMELINE-095]', () => {
  // Regression: a window longer than ~6 days that does not start at midnight fits
  // no 7-day span. minimapSpan then built a NEW object with the same bounds on every
  // render, TimelineView's render-time `setMmSpan` saw a "change" every time and
  // React stopped with error #301 (too many re-renders) after a wheel zoom-out.
  const DAY = 86_400_000;
  const end = Date.UTC(2026, 10, 12, 13, 0);
  const start = end - 7 * DAY; // a week-long window that does not start at midnight
  it('returns prev when the fallback span equals it', () => {
    const first = minimapSpan(null, start, end, 0);
    const second = minimapSpan(first, start, end, 0);
    expect(second).toBe(first);
  });
  it('widens to the days a month-long window touches and keeps that span [WEB-TIMELINE-094]', () => {
    const monthStart = end - 30 * DAY; // the widest window (WEB-TIMELINE-030)
    const first = minimapSpan(null, monthStart, end, 0);
    expect(first.end - first.start).toBe(31 * DAY);
    expect(first.start).toBeLessThanOrEqual(monthStart);
    expect(first.end).toBeGreaterThanOrEqual(end);
    expect(minimapSpan(first, monthStart, end, 0)).toBe(first);
    // Zooming back in inside the wide span keeps it (the span is sticky).
    expect(minimapSpan(first, end - DAY, end, 0)).toBe(first);
    expect(binCount(first)).toBe(31 * 24);
  });
  it('is stable with a now-line too', () => {
    const now = end + 3_600_000;
    const first = minimapSpan(null, start, end, now);
    expect(minimapSpan(first, start, end, now)).toBe(first);
  });
});

describe('year window [WEB-TIMELINE-030] [WEB-TIMELINE-094] [WEB-TIMELINE-098]', () => {
  const end = Date.UTC(2026, 10, 12, 13, 0);
  it('allows a year and spans the days it touches with daily bins', () => {
    expect(MAX_WINDOW_MS).toBe(365 * DAY_MS);
    const span = minimapSpan(null, end - MAX_WINDOW_MS, end, 0);
    expect(span.end - span.start).toBe(366 * DAY_MS);
    expect(binMs(span)).toBe(DAY_MS);
    expect(binCount(span)).toBe(366);
    expect(binMs({ start: 0, end: 7 * DAY_MS })).toBe(HOUR_MS);
  });
  it('puts per-day counts into the bin of their day', () => {
    const span = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 15) };
    const { bins, max } = dailyBins(new Map([['2026-01-01', 4], ['2026-02-14', 9], ['2025-12-31', 50]]), span);
    expect(bins.length).toBe(45);
    expect(bins[0]).toBe(4);
    expect(bins[44]).toBe(9);
    expect(max).toBe(9);
  });
});
