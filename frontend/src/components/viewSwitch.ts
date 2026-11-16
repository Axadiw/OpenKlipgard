/** Where a header nav item leads (WEB-SHELL-016, WEB-SHELL-071).
 *
 *  Switching between the two recordings views keeps the shared filter
 *  parameters and drops the ones that belong only to the view being left.
 *  Coming from any other page (Settings, a 404) the view opens clean: the
 *  parameters of that page mean nothing to the grid or the timeline. */

export type ViewTarget = 'grid' | 'timeline';

/** Parameters that only the view being LEFT understands. */
const DROP_WHEN_LEAVING: Record<ViewTarget, string[]> = {
  // grid → timeline: the modal player pair would become the inline player.
  grid: ['event', 'view'],
  // timeline → grid: `date` is timeline-only, and the inline-player triple
  // would auto-open the modal player on top of the grid.
  timeline: ['date', 'event', 'view', 't'],
};

export function viewOf(pathname: string): ViewTarget | null {
  if (pathname === '/grid' || pathname.startsWith('/grid/')) return 'grid';
  if (pathname === '/timeline' || pathname.startsWith('/timeline/')) return 'timeline';
  return null;
}

/** The URL a nav item for `target` navigates to from `pathname` + `search`. */
export function viewHref(target: ViewTarget, pathname: string, search: string): string {
  const from = viewOf(pathname);
  if (from === null) return `/${target}`;
  if (from === target) return `/${target}${search}`;
  const next = new URLSearchParams(search);
  for (const k of DROP_WHEN_LEAVING[from]) next.delete(k);
  const qs = next.toString();
  return `/${target}${qs ? `?${qs}` : ''}`;
}

export function rememberViewMode(target: ViewTarget) {
  try { localStorage.setItem('viewMode', target); } catch { /* storage blocked: the mode is just not remembered */ }
}
