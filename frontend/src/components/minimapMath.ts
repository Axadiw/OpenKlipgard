// Pure maths of the week minimap: span, bins, hit-test and drag to window.
// Everything is in wall-clock-baked-as-UTC milliseconds, the axis of the rows.
// [WEB-TIMELINE-094] to [WEB-TIMELINE-110]

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Shortest span of the minimap. A longer window widens it, see minimapSpan. */
export const MINIMAP_DAYS = 7;
export const MIN_WINDOW_MS = 2 * 60_000;
/** [WEB-TIMELINE-030]: the widest window of the timeline. */
export const MAX_WINDOW_MS = 365 * DAY_MS;
/** [WEB-TIMELINE-111]: a window longer than this shows whole days, not recordings. */
export const DAY_MODE_MS = 31 * DAY_MS;

export interface Span { start: number; end: number }
export interface Win { viewStart: number; viewEnd: number }
export type MinimapHit = 'left' | 'right' | 'body' | 'outside';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The `days` whole UTC days (7 by default) that end on the day of `ms`. */
export function spanEndingOn(ms: number, days: number = MINIMAP_DAYS): Span {
  const endDay = Math.floor(ms / DAY_MS) * DAY_MS;
  return { start: endDay - (days - 1) * DAY_MS, end: endDay + DAY_MS };
}

/** Whole UTC days the window touches, never fewer than MINIMAP_DAYS [WEB-TIMELINE-094]. */
export function spanDaysFor(viewStart: number, viewEnd: number): number {
  const first = Math.floor(viewStart / DAY_MS);
  const last = Math.floor((Math.max(viewStart, viewEnd - 1)) / DAY_MS);
  return Math.max(MINIMAP_DAYS, last - first + 1);
}

/** One bin per wall-clock hour of the span, or per day for a span longer than
 *  DAY_MODE_MS [WEB-TIMELINE-098]. */
export function binMs(span: Span): number {
  return span.end - span.start > DAY_MODE_MS ? DAY_MS : HOUR_MS;
}

export function binCount(span: Span): number {
  return Math.round((span.end - span.start) / binMs(span));
}

/** [WEB-TIMELINE-098]: daily bins from per-day counts keyed by `YYYY-MM-DD`. */
export function dailyBins(counts: Map<string, number>, span: Span): { bins: Uint16Array; max: number } {
  const n = Math.round((span.end - span.start) / DAY_MS);
  const bins = new Uint16Array(n);
  let max = 0;
  for (const [date, c] of counts) {
    const b = Math.floor((Date.parse(date + 'T00:00:00Z') - span.start) / DAY_MS);
    if (b < 0 || b >= n || !Number.isFinite(b)) continue;
    bins[b] = Math.min(65535, bins[b] + c);
    if (bins[b] > max) max = bins[b];
  }
  return { bins, max };
}

export function windowInside(span: Span, viewStart: number, viewEnd: number): boolean {
  return viewStart >= span.start && viewEnd <= span.end;
}

/** [WEB-TIMELINE-094], [WEB-TIMELINE-095]. `nowWall` is 0 while unknown. */
export function minimapSpan(prev: Span | null, viewStart: number, viewEnd: number, nowWall: number): Span {
  if (prev && windowInside(prev, viewStart, viewEnd)) return prev;
  let next: Span | null = null;
  if (nowWall > 0) {
    const today = spanEndingOn(nowWall);
    if (windowInside(today, viewStart, viewEnd)) next = today;
  }
  next ??= spanEndingOn(Math.max(viewStart, viewEnd - 1), spanDaysFor(viewStart, viewEnd));
  // A window that does not fit the previous span builds a new object on every
  // call, also when its bounds equal the previous span (e.g. a window that starts
  // before the span of today but ends today). Hand back the previous object
  // when the bounds are the same: TimelineView stores the span during render and
  // compares by identity, and a fresh equal object would loop (React error #301).
  return prev && prev.start === next.start && prev.end === next.end ? prev : next;
}

/** [WEB-TIMELINE-098]: one bin per wall-clock hour, by event start. */
export function densityBins(timestamps: number[], span: Span): { bins: Uint16Array; max: number } {
  const n = binCount(span);
  const bins = new Uint16Array(n);
  let max = 0;
  for (const ts of timestamps) {
    const b = Math.floor((ts - span.start) / HOUR_MS);
    if (b < 0 || b >= n) continue;
    if (bins[b] < 65535) bins[b]++;
    if (bins[b] > max) max = bins[b];
  }
  return { bins, max };
}

export function timeToX(t: number, span: Span, width: number): number {
  return ((t - span.start) / (span.end - span.start)) * width;
}

export function xToTime(x: number, span: Span, width: number): number {
  return span.start + (width > 0 ? x / width : 0) * (span.end - span.start);
}

/** [WEB-TIMELINE-102]: rectangle in strip pixels, at least 10 px wide, clipped. */
export function rectPx(win: Win, span: Span, width: number): { x0: number; x1: number } {
  let x0 = clamp(timeToX(win.viewStart, span, width), 0, width);
  let x1 = clamp(timeToX(win.viewEnd, span, width), 0, width);
  if (x1 - x0 < 10) {
    const c = (x0 + x1) / 2;
    x0 = c - 5; x1 = c + 5;
    if (x0 < 0) { x0 = 0; x1 = 10; }
    if (x1 > width) { x1 = width; x0 = Math.max(0, width - 10); }
  }
  return { x0, x1 };
}

/** [WEB-TIMELINE-105] */
export function hitTest(x: number, x0: number, x1: number, tol: number): MinimapHit {
  const inner = Math.min(tol, (x1 - x0) / 3);
  if (x >= x0 - tol && x <= x0 + inner) return 'left';
  if (x >= x1 - inner && x <= x1 + tol) return 'right';
  if (x > x0 + inner && x < x1 - inner) return 'body';
  return 'outside';
}

/** Shift a window of fixed length so it lies inside the span. */
function fitInside(start: number, len: number, span: Span): Win {
  const s = len >= span.end - span.start ? span.start : clamp(start, span.start, span.end - len);
  return { viewStart: Math.round(s), viewEnd: Math.round(s + len) };
}

/** [WEB-TIMELINE-104]: centre a window of the same length on time `t`. */
export function centreWindow(t: number, win: Win, span: Span): Win {
  const len = win.viewEnd - win.viewStart;
  return fitInside(t - len / 2, len, span);
}

/** [WEB-TIMELINE-104], [WEB-TIMELINE-106]: the window after a drag of `deltaMs`. */
export function dragWindow(kind: 'pan' | 'left' | 'right', from: Win, deltaMs: number, span: Span): Win {
  const len = from.viewEnd - from.viewStart;
  if (kind === 'pan') return fitInside(from.viewStart + deltaMs, len, span);
  if (kind === 'left') {
    const lo = Math.max(span.start, from.viewEnd - MAX_WINDOW_MS);
    const hi = from.viewEnd - MIN_WINDOW_MS;
    return { viewStart: Math.round(Math.min(Math.max(from.viewStart + deltaMs, lo), hi)), viewEnd: from.viewEnd };
  }
  const lo = from.viewStart + MIN_WINDOW_MS;
  const hi = Math.min(span.end, from.viewStart + MAX_WINDOW_MS);
  return { viewStart: from.viewStart, viewEnd: Math.round(Math.min(Math.max(from.viewEnd + deltaMs, lo), hi)) };
}

/** [WEB-TIMELINE-110]. Returns null for a key the minimap does not bind. */
export function keyboardWindow(key: string, shift: boolean, from: Win, span: Span): Win | null {
  const len = from.viewEnd - from.viewStart;
  switch (key) {
    case 'ArrowLeft': return dragWindow('pan', from, -(shift ? len : len * 0.1), span);
    case 'ArrowRight': return dragWindow('pan', from, shift ? len : len * 0.1, span);
    case 'Home': return fitInside(span.start, len, span);
    case 'End': return fitInside(span.end - len, len, span);
    default: return null;
  }
}

/** [WEB-TIMELINE-109]: slider numbers in whole seconds from the span start. */
export function sliderValue(win: Win, span: Span): { min: number; max: number; now: number } {
  const max = Math.max(0, Math.round((span.end - span.start - (win.viewEnd - win.viewStart)) / 1000));
  const now = clamp(Math.round((win.viewStart - span.start) / 1000), 0, max);
  return { min: 0, max, now };
}
