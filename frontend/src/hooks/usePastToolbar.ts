import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the page is "past the toolbar" (WEB-GRID-120): the bottom edge of
 * the toolbar's own place in the page is at or above the viewport top. Drives
 * the bottom bar (WEB-GRID-123). The sticky toolbar itself always shows
 * (WEB-GRID-121), so the scroll direction does not matter.
 *
 * `markerRef` is a zero-height element placed right after the toolbar. The
 * page scrolls on `window` (the grid is not a scroll container), so the hook
 * listens there, coalescing scroll events into one read per animation frame.
 */
export function usePastToolbar(markerRef: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = markerRef.current;
      if (el) setPast(el.getBoundingClientRect().top <= 0);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [markerRef]);

  return past;
}
