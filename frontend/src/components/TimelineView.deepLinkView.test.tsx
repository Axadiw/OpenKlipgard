import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
// Imported statically on purpose: a cold import inside a test spends that
// test's time limit on transforming the whole TimelineView tree, and on a
// loaded runner that alone can time a test out.
import { TimelineView } from './TimelineView';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

// Covers two spec/code mismatches found during a spec-verification pass:
//
// [WEB-NOTIF-017] A notification's `?view=<id>` deep-link into `/timeline`
// must resolve the same way the modal player on /grid does: fall back to
// the event's first view when the requested id isn't attached to the event
// (e.g. autoDelete removed the partner lens after the push was sent),
// instead of sending the unmatched id straight to the server, which 404s.
//
// [WEB-TIMELINE-009] A non-404 failure fetching the deep-linked event's
// metadata (network blip, 5xx) must NOT be treated as confirmation the clip
// is gone. The player should still attempt playback from the URL params so
// the normal player machinery runs, instead of silently showing the
// "no clip selected" placeholder.

const DUAL_VIEW_EVENT: CameraEvent = {
  id: 'ev-dual', camera: 'Front', timestamp: '2026-07-31T09:00:00.000Z', date: '2026-07-31',
  timezone: 'UTC', duration: 30,
  views: [
    { id: '00', videoRelPath: 'front/00.mp4', sizeBytes: 1024 },
    { id: '01', videoRelPath: 'front/01.mp4', sizeBytes: 1024 },
  ],
  thumbnail: null,
};

const { getVideoUrl, getEvent } = vi.hoisted(() => ({
  getVideoUrl: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body?: Record<string, unknown>) { super(message); }
  }
  return {
    api: {
      getEvents: () => Promise.resolve({ events: [] }),
      getAccountTimezone: () => Promise.resolve({ timezone: 'UTC' }),
      getEventCalendar: () => Promise.resolve({ days: [] }),
      getEvent: (id: string) => getEvent(id),
      getCameras: () => Promise.resolve({ cameras: ['Front'] }),
      getVideoUrl: (...a: unknown[]) => getVideoUrl(...a),
      getFrameGrid: () => Promise.resolve({ frames: [] }),
      fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
    },
    ApiError,
  };
});

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('klipgard.accountTimezone', 'UTC');
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse('2026-07-31T10:00:00.000Z'));
  getVideoUrl.mockReset();
  getVideoUrl.mockResolvedValue({ videoUrl: 'blob:video', totalBytes: 1024 });
  getEvent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // These tests seed `window.location` directly (see the comments below),
  // which — unlike MemoryRouter state — is NOT scoped to this file's test
  // environment and otherwise leaks a stale `?event=` into whichever test
  // file's component construction happens to run next against the same
  // jsdom/happy-dom window.
  window.history.replaceState({}, '', '/');
});

describe('TimelineView deep-link view resolution', () => {
  it('[WEB-NOTIF-017] falls back to the event\'s first view when ?view= does not match any attached view', async (ctx) => {
    story(ctx, 'Link z powiadomienia niesie view=wide, ale wydarzenie ma tylko 00/01 (partner lens padł ofiarą autoDelete). Oś czasu ma dograć pierwszy dostępny widok, a nie wysłać "wide" do serwera.');
    getEvent.mockResolvedValue({ event: DUAL_VIEW_EVENT });
    // The view seeds its window from `window.location.search` directly (not
    // from the router), so MemoryRouter's entry alone wouldn't reach it.
    window.history.replaceState({}, '', '/timeline?event=ev-dual&view=wide');
    renderWithRouter(
      <TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />,
      { route: '/timeline?event=ev-dual&view=wide' },
    );

    await waitFor(() => expect(getVideoUrl).toHaveBeenCalled());
    expect(getVideoUrl).toHaveBeenCalledWith('ev-dual', '00');
    expect(getVideoUrl.mock.calls.some(call => call[1] === 'wide')).toBe(false);
  });

  it('[WEB-TIMELINE-009] attempts playback from the URL params on a non-404 metadata failure, instead of leaving the player on the empty placeholder', async (ctx) => {
    story(ctx, 'Chwilowy błąd (nie 404) przy pobieraniu metadanych wydarzenia z linku głębokiego nie powinien zostawiać gracza na placeholderze "wybierz klip do odtworzenia" — powinien spróbować odtworzyć klip z parametrów URL jak każdy inny.');
    const { ApiError } = await import('../api');
    getEvent.mockRejectedValue(new ApiError('boom', 500));
    window.history.replaceState({}, '', '/timeline?event=ev-transient&view=00');
    renderWithRouter(
      <TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />,
      { route: '/timeline?event=ev-transient&view=00' },
    );

    await waitFor(() => expect(getVideoUrl).toHaveBeenCalled());
    expect(getVideoUrl).toHaveBeenCalledWith('ev-transient', '00');
    expect(screen.queryByText('timeline.selectToPlay')).toBeNull();
  });
});
