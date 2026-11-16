import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

// Camera filters, empty states, dead-space clicks and token failures of the
// timeline: WEB-TIMELINE-021, 044, 051, 070 and 080.

const REAL_NOW = Date.parse('2026-07-31T10:00:00.000Z');
const SLOW = 30_000; // TimelineView is a heavy import on a loaded machine

function ev(id: string, camera: string, timestamp: string): CameraEvent {
  return {
    id, camera, timestamp, date: timestamp.slice(0, 10), timezone: 'UTC', duration: 30,
    views: [{ id: '00', videoRelPath: `${camera}/00.mp4`, sizeBytes: 1024 }],
    thumbnail: null,
  } as CameraEvent;
}

const getEvents = vi.fn();
const getVideoUrl = vi.fn();
const getCameras = vi.fn();

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body?: Record<string, unknown>) { super(message); }
  }
  return {
    api: {
      getEvents: (...a: unknown[]) => getEvents(...a),
      getAccountTimezone: () => Promise.resolve({ timezone: 'UTC' }),
      getEventCalendar: () => Promise.resolve({ days: [] }),
      getEvent: (id: string) => Promise.resolve({ event: { id } }),
      getCameras: () => getCameras(),
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

/** Answer the per-day fetches of the timeline from a date -> events table. */
function serveDays(byDate: Record<string, CameraEvent[]>, latest: CameraEvent[] = []) {
  getEvents.mockImplementation((params: { dateFrom?: string; limit?: number; camera?: string[] }) => {
    if (params.limit === 1 && !params.dateFrom) return Promise.resolve({ events: latest });
    return Promise.resolve({ events: byDate[params.dateFrom ?? ''] ?? [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('klipgard.accountTimezone', 'UTC');
  getEvents.mockReset();
  getVideoUrl.mockReset();
  getVideoUrl.mockResolvedValue({ videoUrl: 'blob:video', totalBytes: 1024 });
  getCameras.mockReset();
  getCameras.mockResolvedValue({ cameras: ['Front', 'Porch'] });
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(REAL_NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(opts: { route?: string; cameraFilter?: string[]; allCameras?: string[] } = {}) {
  const { TimelineView } = await import('./TimelineView');
  return renderWithRouter(
    <TimelineView cameraFilter={opts.cameraFilter ?? []} onPlay={() => {}} allCameras={opts.allCameras ?? ['Front', 'Porch']} />,
    { route: opts.route ?? '/timeline?date=2026-07-31' },
  );
}

const latestCall = () => getEvents.mock.calls.map(c => c[0]).find((p: { limit?: number; dateFrom?: string }) => p.limit === 1 && !p.dateFrom);

describe('TimelineView — latest-clip auto-open respects the camera filters', () => {
  it('[WEB-TIMELINE-021] asks only for the include-filtered cameras', async (ctx) => {
    story(ctx, 'Użytkownik wszedł z siatki z filtrem kamer. Automatyczne otwarcie najnowszego klipu pyta serwer tylko o te kamery, więc klip ma swój wiersz na osi czasu.');
    serveDays({}, [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')]);
    await mount({ route: '/timeline', cameraFilter: ['Front'] });
    await waitFor(() => expect(latestCall()).toBeTruthy(), { timeout: SLOW });
    expect(latestCall().camera).toEqual(['Front']);
    await waitFor(() => expect(getVideoUrl).toHaveBeenCalledWith('ev-front', '00'), { timeout: SLOW });
  }, SLOW * 2);

  it('[WEB-TIMELINE-021] leaves out the cameras the hide-filter hides', async (ctx) => {
    story(ctx, 'Użytkownik ukrył kamerę w filtrze osi czasu. Automatyczne otwarcie najnowszego klipu pomija ukrytą kamerę, żeby klip nie grał bez wiersza, do którego należy.');
    localStorage.setItem('klipgard.timelineHiddenCameras', JSON.stringify(['Porch']));
    serveDays({}, [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')]);
    await mount({ route: '/timeline' });
    await waitFor(() => expect(latestCall()).toBeTruthy(), { timeout: SLOW });
    expect(latestCall().camera).toEqual(['Front']);
  }, SLOW * 2);

  it('[WEB-TIMELINE-021] opens nothing when the filters hide every camera', async (ctx) => {
    story(ctx, 'Gdy filtr ukrywa wszystkie kamery, nie ma czego otworzyć — odtwarzacz zostaje pusty, a widok na dzisiejszej dobie.');
    localStorage.setItem('klipgard.timelineHiddenCameras', JSON.stringify(['Front', 'Porch']));
    serveDays({}, [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')]);
    await mount({ route: '/timeline' });
    await waitFor(() => expect(getEvents).toHaveBeenCalled(), { timeout: SLOW });
    expect(latestCall()).toBeUndefined();
    expect(getVideoUrl).not.toHaveBeenCalled();
  }, SLOW * 2);
});

describe('TimelineView — empty states and rows count only events inside the window', () => {
  it('[WEB-TIMELINE-044] says the cameras are hidden, not that the day is empty', async (ctx) => {
    story(ctx, 'Użytkownik odznaczył wszystkie kamery w filtrze osi czasu. Zamiast mylącego "Brak zdarzeń tego dnia" widzi, że wszystkie kamery są ukryte i trzeba sprawdzić filtr.');
    localStorage.setItem('klipgard.timelineHiddenCameras', JSON.stringify(['Front']));
    serveDays({ '2026-07-31': [ev('ev-1', 'Front', '2026-07-31T09:00:00.000Z')] });
    await mount();
    await waitFor(() => expect(screen.getByTestId('timeline-empty')).toHaveTextContent('timeline.allCamerasHidden'), { timeout: SLOW });
  }, SLOW * 2);

  it('[WEB-TIMELINE-044] still says there are no events when the day is empty', async (ctx) => {
    story(ctx, 'Doba bez nagrań dalej pokazuje zwykły komunikat o braku zdarzeń.');
    serveDays({});
    await mount();
    await waitFor(() => expect(screen.getByTestId('timeline-empty')).toHaveTextContent('timeline.noEvents'), { timeout: SLOW });
  }, SLOW * 2);

  it('[WEB-TIMELINE-070] draws no row for a camera whose only events are on the next day', async (ctx) => {
    story(ctx, 'Oś pobiera też następną dobę jako zapas dla linii granicy dnia. Kamera, która ma nagrania tylko jutro, nie dostaje dziś pustego wiersza.');
    serveDays({
      '2026-07-31': [ev('ev-front', 'Front', '2026-07-31T12:00:00.000Z')],
      '2026-08-01': [ev('ev-porch', 'Porch', '2026-08-01T03:00:00.000Z')],
    });
    await mount();
    await screen.findByTestId('timeline-cam-Front', undefined, { timeout: SLOW });
    expect(screen.queryByTestId('timeline-cam-Porch')).toBeNull();
  }, SLOW * 2);

  it('[WEB-TIMELINE-070] shows the empty message when only the next day has events', async (ctx) => {
    story(ctx, 'Gdy w oknie nie ma żadnego nagrania, a jutrzejsze zdarzenia są tylko zapasem, komunikat "Brak zdarzeń tego dnia" nadal się pokazuje.');
    serveDays({ '2026-08-01': [ev('ev-porch', 'Porch', '2026-08-01T03:00:00.000Z')] });
    await mount();
    await waitFor(() => expect(screen.getByTestId('timeline-empty')).toHaveTextContent('timeline.noEvents'), { timeout: SLOW });
    expect(screen.queryByTestId('timeline-cam-Porch')).toBeNull();
  }, SLOW * 2);
});

describe('TimelineView — click in empty space', () => {
  it('[WEB-TIMELINE-051] opens the nearest event of a visible camera, not a hidden or first-listed one', async (ctx) => {
    story(ctx, 'Kliknięcie w pustkę na osi otwiera klip najbliższy w czasie. Kamera ukryta filtrem nie wygrywa, a kolejność kamer w odpowiedzi serwera nie ma znaczenia.');
    localStorage.setItem('klipgard.timelineHiddenCameras', JSON.stringify(['Alpha']));
    serveDays({
      '2026-07-31': [
        ev('ev-beta', 'Beta', '2026-07-31T10:00:00.000Z'),   // 180 s from the click
        ev('ev-gamma', 'Gamma', '2026-07-31T10:04:00.000Z'), //  60 s from the click, and later in the response
        ev('ev-alpha', 'Alpha', '2026-07-31T10:03:10.000Z'), //  10 s from the click, but hidden
      ],
    });
    await mount({ allCameras: ['Alpha', 'Beta', 'Gamma'] });
    await screen.findByTestId('timeline-cam-Gamma', undefined, { timeout: SLOW });
    // 10:03:00 on a 24 h window drawn 800 px wide: 36180 s / 86400 s * 800 px.
    fireEvent.click(screen.getByTestId('timeline-ruler'), { clientX: (36180 / 86400) * 800 });
    await waitFor(() => expect(getVideoUrl).toHaveBeenCalledWith('ev-gamma', '00'), { timeout: SLOW });
    expect(getVideoUrl).not.toHaveBeenCalledWith('ev-alpha', '00');
    expect(getVideoUrl).not.toHaveBeenCalledWith('ev-beta', '00');
  }, SLOW * 2);
});

describe('TimelineView — media-token failure other than a locked account', () => {
  it('[WEB-TIMELINE-080] shows a failure message with Retry instead of loading forever', async (ctx) => {
    story(ctx, 'Pobranie zgody na odtworzenie klipu zawiodło z powodu sieci. Zamiast wiecznego "Loading..." odtwarzacz pokazuje błąd i przycisk Ponów, który ponawia pobranie.');
    getVideoUrl.mockRejectedValueOnce(new Error('network down'));
    serveDays({ '2026-07-31': [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')] }, [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')]);
    await mount({ route: '/timeline' });

    const errorBox = await screen.findByTestId('timeline-inline-token-error', undefined, { timeout: SLOW });
    expect(errorBox).toHaveTextContent('timeline.failedToLoad');
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByTestId('timeline-inline-locked')).toBeNull();

    fireEvent.click(screen.getByTestId('timeline-inline-token-retry'));
    await waitFor(() => expect(getVideoUrl).toHaveBeenCalledTimes(2), { timeout: SLOW });
    await waitFor(() => expect(screen.queryByTestId('timeline-inline-token-error')).toBeNull(), { timeout: SLOW });
  }, SLOW * 2);

  it('[WEB-TIMELINE-080] a locked account still sees the locked message, not the failure', async (ctx) => {
    story(ctx, 'Blokada konta (403 ACCOUNT_LOCKED) nadal ma własny komunikat — nie dostaje ogólnego błędu z przyciskiem Ponów.');
    const { ApiError } = await import('../api');
    getVideoUrl.mockRejectedValue(new ApiError('Account locked', 403, { code: 'ACCOUNT_LOCKED' }));
    serveDays({}, [ev('ev-front', 'Front', '2026-07-31T09:00:00.000Z')]);
    await mount({ route: '/timeline' });
    await screen.findByTestId('timeline-inline-locked', undefined, { timeout: SLOW });
    expect(screen.queryByTestId('timeline-inline-token-error')).toBeNull();
  }, SLOW * 2);
});
