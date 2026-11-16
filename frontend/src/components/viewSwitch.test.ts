import { describe, it, expect } from 'vitest';
import { viewHref, viewOf } from './viewSwitch';

describe('viewOf', () => {
  it('names the recordings view of a path', () => {
    expect(viewOf('/grid')).toBe('grid');
    expect(viewOf('/timeline')).toBe('timeline');
    expect(viewOf('/settings/general')).toBeNull();
    expect(viewOf('/gridlock')).toBeNull();
  });
});

describe('viewHref [WEB-SHELL-016]', () => {
  it('grid → timeline keeps the shared filters and drops event and view', () => {
    expect(viewHref('timeline', '/grid', '?cameras=Front&event=e1&view=01&mode=range'))
      .toBe('/timeline?cameras=Front&mode=range');
  });

  it('timeline → grid drops date, event, view and t', () => {
    expect(viewHref('grid', '/timeline', '?cameras=Back&date=2026-11-12&event=e2&view=00&t=12.5'))
      .toBe('/grid?cameras=Back');
  });

  it('opens the view clean from any other page', () => {
    expect(viewHref('grid', '/settings/storage', '?changePassword=1')).toBe('/grid');
    expect(viewHref('timeline', '/settings', '')).toBe('/timeline');
  });

  it('points the current view at itself with its parameters', () => {
    expect(viewHref('grid', '/grid', '?cameras=Front')).toBe('/grid?cameras=Front');
  });
});
