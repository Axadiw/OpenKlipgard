import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import type { Locale } from 'date-fns';
import {
  DAY_MS, MINIMAP_DAYS, binCount, hitTest, rectPx, timeToX, xToTime,
  centreWindow, dragWindow, keyboardWindow, sliderValue,
} from './minimapMath';
import type { Span, Win } from './minimapMath';

// [WEB-TIMELINE-092] to [WEB-TIMELINE-110]: the week minimap under the camera rows.

const MOUSE_GRIP_PX = 6;
const TOUCH_GRIP_PX = 12;
const LABEL_ROW_PX = 16;       // top band that holds the day labels
const BAR_MIN_PX = 3;
const BAR_PAD_BOTTOM = 4;
const NARROW_DAY_PX = 72;      // below this a day label is shortened
const MIN_LABEL_DAY_PX = 16;   // below this the day lines stay, the labels go
const MAX_DPR = 2;

interface Props {
  span: Span;
  bins: Uint16Array;
  maxBin: number;
  viewStart: number;
  viewEnd: number;
  /** Wall-clock "now", 0 while unknown. */
  now: number;
  locale: Locale;
  title: string;
  ariaLabel: string;
  /** Date label of the window, used as the slider value text. */
  valueText: string;
  onWindowChange: (win: Win) => void;
}

type Drag = {
  kind: 'pan' | 'left' | 'right';
  pointerId: number;
  startClientX: number;
  from: Win;
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function TimelineMinimapImpl({
  span, bins, maxBin, viewStart, viewEnd, now, locale, title, ariaLabel, valueText, onWindowChange,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [themeTick, setThemeTick] = useState(0);

  // Latest props for the pointer handlers, so they never rebind during a drag.
  const live = useRef({ span, viewStart, viewEnd, width: 0, onWindowChange });
  useEffect(() => {
    live.current = { span, viewStart, viewEnd, width: size.w, onWindowChange };
  });

  const dragRef = useRef<Drag | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<Win | null>(null);

  // --- size ---
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // --- theme: the colours come from CSS variables, so a switch needs a repaint ---
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick(n => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => obs.disconnect();
  }, []);

  // --- draw ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const { w, h } = size;
    if (!canvas || w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const accent = cssVar('--accent');
    const success = cssVar('--success');
    const text2 = cssVar('--text2');
    const border = cssVar('--border');
    const spanMs = span.end - span.start;

    // Hourly bars, growing from the bottom edge.
    const nBins = binCount(span);
    const bw = w / nBins;
    const maxH = Math.max(BAR_MIN_PX, h - LABEL_ROW_PX - BAR_PAD_BOTTOM);
    ctx.fillStyle = accent;
    for (let b = 0; b < nBins; b++) {
      const n = bins[b];
      if (!n) continue;
      const ratio = n / Math.max(1, maxBin);
      const bh = BAR_MIN_PX + ratio * (maxH - BAR_MIN_PX);
      ctx.globalAlpha = 0.35 + 0.55 * ratio;
      ctx.fillRect(b * bw + 0.25, h - BAR_PAD_BOTTOM - bh, Math.max(1, bw - 0.5), bh);
    }
    ctx.globalAlpha = 1;

    // Day lines and labels.
    const dayPx = (DAY_MS / spanMs) * w;
    const wide = dayPx >= NARROW_DAY_PX;
    // A span longer than a week shows the day of the month, which tells days apart
    // over a month; a weekday alone would repeat [WEB-TIMELINE-100].
    const monthLike = spanMs > MINIMAP_DAYS * DAY_MS;
    const labelFmt = wide ? 'EEE d' : monthLike ? 'd' : 'EEE';
    const showLabels = dayPx >= MIN_LABEL_DAY_PX;
    ctx.font = `500 10px ${getComputedStyle(canvas).fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'alphabetic';
    for (let d = 0; d * DAY_MS < spanMs; d++) {
      const t = span.start + d * DAY_MS;
      const x = timeToX(t, span, w);
      if (d > 0) {
        ctx.fillStyle = border;
        ctx.fillRect(Math.round(x), 3, 1, h - 6);
      }
      const day = new Date(t);
      // Local noon of the UTC date: date-fns formats with local getters.
      const noon = new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
      if (!showLabels) continue;
      ctx.fillStyle = text2;
      ctx.fillText(format(noon, labelFmt, { locale }), x + 4, 12);
    }

    // Now-line.
    if (now > span.start && now < span.end) {
      const nx = timeToX(now, span, w);
      ctx.fillStyle = success;
      ctx.fillRect(nx - 0.75, 2, 1.5, h - 4);
    }

    // Viewport rectangle and grips.
    const { x0, x1 } = rectPx({ viewStart, viewEnd }, span, w);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.14;
    roundRect(ctx, x0, 1, x1 - x0, h - 2, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    roundRect(ctx, x0 + 0.75, 1.75, Math.max(1, x1 - x0 - 1.5), h - 3.5, 6);
    ctx.stroke();
    const gripH = Math.min(16, h - 12);
    ctx.fillStyle = accent;
    roundRect(ctx, x0 + 1.5, (h - gripH) / 2, 3, gripH, 1.5);
    ctx.fill();
    roundRect(ctx, x1 - 4.5, (h - gripH) / 2, 3, gripH, 1.5);
    ctx.fill();
  }, [size, span, bins, maxBin, viewStart, viewEnd, now, locale, themeTick]);

  // --- gestures ---
  const flush = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const win = pendingRef.current;
    pendingRef.current = null;
    if (win) live.current.onWindowChange(win);
  }, []);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const localX = (e: React.PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return; // a second finger or button is ignored
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const { span: sp, viewStart: vs, viewEnd: ve, width } = live.current;
    if (width <= 0) return;
    const x = localX(e);
    const tol = e.pointerType === 'touch' ? TOUCH_GRIP_PX : MOUSE_GRIP_PX;
    const { x0, x1 } = rectPx({ viewStart: vs, viewEnd: ve }, sp, width);
    const hit = hitTest(x, x0, x1, tol);
    let from: Win = { viewStart: vs, viewEnd: ve };
    let kind: Drag['kind'] = 'pan';
    if (hit === 'left') kind = 'left';
    else if (hit === 'right') kind = 'right';
    else if (hit === 'outside') {
      from = centreWindow(xToTime(x, sp, width), from, sp);
      live.current.onWindowChange(from);
    }
    dragRef.current = { kind, pointerId: e.pointerId, startClientX: e.clientX, from };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.currentTarget.style.cursor = kind === 'pan' ? 'grabbing' : 'ew-resize';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const { span: sp, viewStart: vs, viewEnd: ve, width } = live.current;
    if (!drag) {
      if (e.pointerType === 'touch' || width <= 0) return;
      const { x0, x1 } = rectPx({ viewStart: vs, viewEnd: ve }, sp, width);
      const hit = hitTest(localX(e), x0, x1, MOUSE_GRIP_PX);
      e.currentTarget.style.cursor = hit === 'body' ? 'grab' : hit === 'outside' ? 'pointer' : 'ew-resize';
      return;
    }
    if (drag.pointerId !== e.pointerId || width <= 0) return;
    const deltaMs = ((e.clientX - drag.startClientX) / width) * (sp.end - sp.start);
    pendingRef.current = dragWindow(drag.kind, drag.from, deltaMs, sp);
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const win = pendingRef.current;
        pendingRef.current = null;
        if (win) live.current.onWindowChange(win);
      });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    flush();
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    e.currentTarget.style.cursor = '';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const { span: sp, viewStart: vs, viewEnd: ve } = live.current;
    const win = keyboardWindow(e.key, e.shiftKey, { viewStart: vs, viewEnd: ve }, sp);
    if (!win) return;
    e.preventDefault();
    e.stopPropagation();
    if (win.viewStart !== vs || win.viewEnd !== ve) live.current.onWindowChange(win);
  };

  const sv = sliderValue({ viewStart, viewEnd }, span);

  return (
    <div className="timeline-minimap" data-testid="timeline-minimap">
      <div className="timeline-minimap-gutter">{title}</div>
      <div
        className="timeline-minimap-strip"
        ref={stripRef}
        role="slider"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        aria-valuemin={sv.min}
        aria-valuemax={sv.max}
        aria-valuenow={sv.now}
        aria-valuetext={valueText}
        data-testid="timeline-minimap-strip"
        data-span-start={span.start}
        data-span-end={span.end}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} aria-hidden="true" style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}

export const TimelineMinimap = memo(TimelineMinimapImpl);
