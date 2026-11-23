import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';

const getEvents = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({
  api: {
    getEvents,
    getCameras: () => Promise.resolve({ cameras: [] }),
    // Never settles: the zone is not what this test is about.
    getAccountTimezone: () => new Promise(() => {}),
    fetchThumbnailBlob: (id: string) => Promise.resolve(`blob:thumbnail-${id}`),
    getEvent: (id: string) => Promise.resolve({ event: { id, thumbnail: null } }),
  },
}));
vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));
vi.mock('../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { thumbSize: 'M' }, setThumbSize: vi.fn() }),
}));
// The connection details of the first-time card are not under test here.
vi.mock('../hooks/useServerConfig', () => ({ useServerConfig: () => null }));
vi.mock('../edition', () => ({ edition: { cameraConnect: null } }));
vi.mock('./AuthedShell', () => ({
  useShell: () => ({ openPlayer: vi.fn(), setBulkDelete: vi.fn(), setBulkDeleteOnDone: vi.fn() }),
}));
vi.mock('./FilterBar', () => ({ FilterBar: () => null }));
vi.mock('./ProcessingStatusIndicator', () => ({ ProcessingStatusIndicator: () => null }));

const REFRESH_MS = 60_000;

describe('GridView — the 60 s refresh of an account with no recordings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    });
    getEvents.mockReset();
    getEvents.mockResolvedValue({ events: [], total: 0, nextCursor: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('[WEB-GRID-071] [WEB-GRID-095] keeps the first-time card on screen and asks the server again', async (ctx) => {
    story(ctx, 'Konto bez nagrań zostawia siatkę otwartą. Co minutę siatka pyta serwer o nowe nagrania, ale karta „Brak nagrań” zostaje ta sama: nie znika na chwilę i nie jest rysowana od nowa.');
    const { GridView } = await import('./GridView');
    renderWithRouter(<GridView />, { route: '/grid' });
    await flush(0);
    const card = screen.getByTestId('empty-recordings');
    expect(getEvents).toHaveBeenCalledTimes(1);

    await flush(REFRESH_MS);

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('empty-recordings')).toBe(card);
    expect(screen.queryByText('events.loading')).toBeNull();
  });

  it('[WEB-GRID-071] [WEB-GRID-095] keeps the filtered card on screen too', async (ctx) => {
    story(ctx, 'To samo dotyczy karty „Brak pasujących nagrań”, gdy filtry nic nie znajdują: odświeżenie co minutę nie wymienia jej na „Ładowanie…”.');
    const { GridView } = await import('./GridView');
    renderWithRouter(<GridView />, { route: '/grid?cameras=Backyard' });
    await flush(0);
    const card = screen.getByTestId('empty-recordings');
    expect(screen.getByTestId('clear-filters')).toBeInTheDocument();

    await flush(REFRESH_MS);

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('empty-recordings')).toBe(card);
  });

  it('[WEB-GRID-071] replaces the card with the grid when the refresh finds a first recording', async (ctx) => {
    story(ctx, 'Pierwsze nagranie z kamery trafia do siatki przy najbliższym odświeżeniu, a karta „Brak nagrań” ustępuje miejsca kafelkom.');
    const { GridView } = await import('./GridView');
    renderWithRouter(<GridView />, { route: '/grid' });
    await flush(0);
    expect(screen.getByTestId('empty-recordings')).toBeInTheDocument();
    getEvents.mockResolvedValue({
      events: [{
        id: 'e1', camera: 'Front', timestamp: '2026-04-01T10:00:00.000Z', date: '2026/04/01',
        views: [{ id: '00', videoRelPath: '2026/04/01/Front_00.mp4', label: 'profile.view.wide', iconKind: 'wide' }],
        thumbnail: '2026/04/01/Front_00.jpg',
      }],
      total: 1,
      nextCursor: null,
    });

    await flush(REFRESH_MS);

    expect(screen.queryByTestId('empty-recordings')).toBeNull();
    expect(document.querySelectorAll('.event-card')).toHaveLength(1);
  });
});
