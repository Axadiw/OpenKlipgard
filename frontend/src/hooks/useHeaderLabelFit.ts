import { useEffect, useLayoutEffect, type RefObject } from 'react';

/** How much of its labels the view switch shows, widest first (WEB-SHELL-080). */
export type LabelFit = 'both' | 'current' | 'none';
const MODES: LabelFit[] = ['both', 'current', 'none'];

/** True when the header row keeps all its content inside its own padding. */
export function rowFits(header: HTMLElement): boolean {
  if (header.scrollWidth > header.clientWidth) return false;
  const last = header.lastElementChild;
  if (!last) return true;
  const padRight = parseFloat(getComputedStyle(header).paddingRight) || 0;
  // Half a pixel of slack for sub-pixel layout.
  return last.getBoundingClientRect().right <= header.getBoundingClientRect().right - padRight + 0.5;
}

/**
 * Writes the widest label mode whose header row fits to `data-labels` on the
 * view switch (WEB-SHELL-080). The CSS hides the labels that mode names. The row
 * is measured as it is laid out, so the answer holds for every language, every
 * font and every text size: a width tuned on one language's labels would not.
 */
export function fitHeaderLabels(nav: HTMLElement, fits: (header: HTMLElement) => boolean = rowFits): LabelFit {
  const header = nav.closest<HTMLElement>('.app-header');
  if (!header) return 'both';
  for (const mode of MODES) {
    nav.dataset.labels = mode;
    if (fits(header)) return mode;
  }
  return 'none';
}

/**
 * Keeps `data-labels` of the view switch right. It runs after every render of
 * the switch, before the browser paints, because a new language or a new current
 * item changes the labels. It runs again when the header changes size or a web
 * font arrives.
 */
export function useHeaderLabelFit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (ref.current) fitHeaderLabels(ref.current);
  });

  useEffect(() => {
    const nav = ref.current;
    const header = nav?.closest<HTMLElement>('.app-header');
    if (!nav || !header) return;
    const fit = () => { fitHeaderLabels(nav); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(header);
    void document.fonts?.ready.then(fit);
    return () => observer?.disconnect();
  }, [ref]);
}
