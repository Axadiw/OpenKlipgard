import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { story } from '../test-story';
import { readParams, useRecordings, hasActiveFilter, type Filters } from './useRecordings';

function mkFilters(overrides: Partial<Filters> = {}): Filters {
  return {
    cameras: [],
    mode: 'range',
    dateFrom: '',
    dateTo: '',
    timeFrom: '',
    timeTo: '',
    rangeFrom: '',
    rangeTo: '',
    ...overrides,
  };
}

describe('hasActiveFilter', () => {
  it('is false for pristine filters (no cameras, range mode, all empty)', () => {
    expect(hasActiveFilter(mkFilters())).toBe(false);
  });

  it('is true when any camera is selected', () => {
    expect(hasActiveFilter(mkFilters({ cameras: ['Front'] }))).toBe(true);
  });

  it('[WEB-GRID-037] is true in range mode when either end is set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeFrom: '2026-05-20T08:00', rangeTo: '2026-05-20T18:00' }))).toBe(true);
    // A lone range end counts, like the Filters badge (one filled field = 1).
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeFrom: '2026-05-20T08:00' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeTo: '2026-05-20T18:00' }))).toBe(true);
  });

  it('[WEB-GRID-037] is true in daily mode when a single date bound is set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily', dateFrom: '2026-05-20' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', dateTo: '2026-05-20' }))).toBe(true);
  });

  it('[WEB-GRID-037] is true in daily mode when either time-of-day end is set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeFrom: '08:00', timeTo: '18:00' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeFrom: '08:00' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeTo: '18:00' }))).toBe(true);
  });

  it('is false in daily mode with no date and no time mask', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily' }))).toBe(false);
  });

  it('ignores range fields while in daily mode and vice versa', () => {
    // rangeFrom/To set but mode is daily → not active (those fields are inert).
    expect(hasActiveFilter(mkFilters({ mode: 'daily', rangeFrom: '2026-05-20T08:00', rangeTo: '2026-05-20T18:00' }))).toBe(false);
    // dateFrom set but mode is range → not active.
    expect(hasActiveFilter(mkFilters({ mode: 'range', dateFrom: '2026-05-20' }))).toBe(false);
  });
});

describe('readParams default mode', () => {
  it('defaults mode to "range" when URL has no mode= parameter', () => {
    const params = new URLSearchParams('');
    const result = readParams(params);
    expect(result.filters.mode).toBe('range');
  });

  it('respects explicit mode=daily in URL', () => {
    const params = new URLSearchParams('mode=daily');
    const result = readParams(params);
    expect(result.filters.mode).toBe('daily');
  });

  it('respects explicit mode=range in URL', () => {
    const params = new URLSearchParams('mode=range');
    const result = readParams(params);
    expect(result.filters.mode).toBe('range');
  });
});

// Regression: PR #235 trimmed the reset effect's dep array to
// `[camerasStr, dateFrom, dateTo, reloadCounter]`, so flipping any other
// filter (mode, timeFrom/To, rangeFrom/To) wrote to the URL but never
// re-fetched. Filters only "took effect" after a full page reload.
// This block tests that Apply on each filter type triggers a refetch.

vi.mock('../api', () => ({
  api: {
    getCameras: vi.fn().mockResolvedValue({ cameras: ['Front', 'Back'] }),
    getEvents: vi.fn().mockResolvedValue({ events: [], total: 0, nextCursor: null }),
  },
}));

// Imported lazily so the mock above is set up before the hook reads it.
async function mockedApi() {
  return (await import('../api')).api as unknown as {
    getEvents: ReturnType<typeof vi.fn>;
    getCameras: ReturnType<typeof vi.fn>;
  };
}

function wrapperWithUrl(initialUrl: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
}

describe('useRecordings — updateFilters triggers refetch (regression for PR #235 dep-array trim)', () => {
  beforeEach(async () => {
    const api = await mockedApi();
    api.getEvents.mockClear();
  });

  it('changing timeFrom (daily mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid?mode=daily&dateFrom=2026-05-20&dateTo=2026-05-20'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ timeFrom: '08:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ timeFrom: '08:00' });
  });

  it('changing timeTo (daily mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid?mode=daily&dateFrom=2026-05-20&dateTo=2026-05-20'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ timeTo: '18:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ timeTo: '18:00' });
  });

  it('changing rangeFrom (range mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ rangeFrom: '2026-05-20T08:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ rangeFrom: '2026-05-20T08:00' });
  });

  it('changing rangeTo (range mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ rangeTo: '2026-05-20T18:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ rangeTo: '2026-05-20T18:00' });
  });

  it('switching mode (range → daily) refetches', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ mode: 'daily', dateFrom: '2026-05-20' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ mode: 'daily', dateFrom: '2026-05-20' });
  });
});

describe('useRecordings — silent refresh uses the current filters (WEB-GRID-074)', () => {
  it('a loadEvents captured before a filter change still refreshes with the new filter', async (ctx) => {
    story(ctx, 'Odświeżanie co 60 s trzyma funkcję z pierwszego renderu. Po włączeniu filtra kamery musi nadal pobierać tylko tę kamerę, a nie całą listę.');
    const api = await mockedApi();
    api.getEvents.mockReset();
    api.getEvents.mockResolvedValue({
      events: [{ id: 'e1', camera: 'Front' }],
      total: 1,
      nextCursor: null,
    });
    const { result } = renderHook(() => useRecordings(), { wrapper: wrapperWithUrl('/grid') });
    // What GridView's interval holds: the loadEvents of the first render.
    const staleLoadEvents = result.current.loadEvents;
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ cameras: ['Front'] }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.events.length).toBe(1));

    await act(async () => { await staleLoadEvents(undefined, undefined, undefined, false); });

    const last = api.getEvents.mock.calls[api.getEvents.mock.calls.length - 1][0];
    expect(last).toMatchObject({ camera: ['Front'] });
  });
});

describe('useRecordings — silent refresh of an empty list (WEB-GRID-071)', () => {
  type Page = { events: object[]; total: number; nextCursor: string | null };
  const empty: Page = { events: [], total: 0, nextCursor: null };

  /** A getEvents answer that stays open until the test settles it. */
  function held() {
    let resolve!: (page: Page) => void;
    const promise = new Promise<Page>(res => { resolve = res; });
    return { promise, resolve };
  }

  /** Mounts the hook on an account with no recordings and runs the first load. */
  async function mountWithEmptyList(url = '/grid') {
    const api = await mockedApi();
    api.getEvents.mockReset();
    api.getEvents.mockResolvedValue(empty);
    const loadingSeen: boolean[] = [];
    const { result } = renderHook(() => {
      const recordings = useRecordings();
      loadingSeen.push(recordings.loading);
      return recordings;
    }, { wrapper: wrapperWithUrl(url) });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    return { api, result, loadingSeen };
  }

  const refresh = (loadEvents: ReturnType<typeof useRecordings>['loadEvents']) =>
    loadEvents(undefined, undefined, undefined, false);

  it('does not show loading while it refetches an empty list', async (ctx) => {
    story(ctx, 'Konto bez nagrań: odświeżenie co 60 s nie przełącza siatki na „Ładowanie…”. Karta „Brak nagrań” zostaje na ekranie, więc nie znika i nie wraca co minutę.');
    const { api, result, loadingSeen } = await mountWithEmptyList();
    const seenBefore = loadingSeen.length;
    const open = held();
    api.getEvents.mockReturnValueOnce(open.promise);

    await act(async () => { void refresh(result.current.loadEvents); });
    expect(api.getEvents).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);

    await act(async () => { open.resolve(empty); });
    expect(result.current.loading).toBe(false);
    expect(loadingSeen.slice(seenBefore)).not.toContain(true);
    expect(result.current.events).toEqual([]);
  });

  it('asks for the first batch, with the filters of the URL and no cursor', async (ctx) => {
    story(ctx, 'Odświeżenie pustej listy prosi o pierwszą paczkę (50 nagrań, bez kursora) i z filtrami z adresu, tak jak pierwsze ładowanie.');
    const { api, result } = await mountWithEmptyList('/grid?cameras=Front');

    await act(async () => { await refresh(result.current.loadEvents); });

    const query = api.getEvents.mock.calls[1][0];
    expect(query).toMatchObject({ limit: 50, camera: ['Front'] });
    expect(query.cursor).toBeUndefined();
  });

  it('puts a first recording on the list without a loading step', async (ctx) => {
    story(ctx, 'Pierwsze nagranie z kamery pojawia się w siatce przy najbliższym odświeżeniu, bez „Ładowania…” w międzyczasie.');
    const { api, result, loadingSeen } = await mountWithEmptyList();
    const seenBefore = loadingSeen.length;
    api.getEvents.mockResolvedValueOnce({ events: [{ id: 'e1', camera: 'Front' }], total: 1, nextCursor: 'c1' });

    await act(async () => { await refresh(result.current.loadEvents); });

    expect(result.current.events.map(e => e.id)).toEqual(['e1']);
    expect(result.current.total).toBe(1);
    expect(result.current.hasMore).toBe(true);
    expect(loadingSeen.slice(seenBefore)).not.toContain(true);
  });

  it('keeps the list empty and stores the message when the refresh fails', async (ctx) => {
    story(ctx, 'Gdy odświeżenie pustej listy się nie uda, siatka nie przechodzi w „Ładowanie…”: karta zostaje, a komunikat błędu jest zapamiętany.');
    const { api, result, loadingSeen } = await mountWithEmptyList();
    const seenBefore = loadingSeen.length;
    api.getEvents.mockRejectedValueOnce(new Error('offline'));

    await act(async () => { await refresh(result.current.loadEvents); });

    expect(result.current.error).toBe('offline');
    expect(result.current.events).toEqual([]);
    expect(loadingSeen.slice(seenBefore)).not.toContain(true);
  });

  it('[WEB-GRID-072] discards a refresh that started before a filter change', async (ctx) => {
    story(ctx, 'Odświeżenie pustej listy, które wystartowało przed zmianą filtra, nie nadpisuje listy nowego filtra, gdy odpowie później.');
    const { api, result } = await mountWithEmptyList();
    const stale = held();
    api.getEvents.mockReturnValueOnce(stale.promise);
    await act(async () => { void refresh(result.current.loadEvents); });

    api.getEvents.mockResolvedValueOnce({ events: [{ id: 'front-1', camera: 'Front' }], total: 1, nextCursor: null });
    act(() => { result.current.updateFilters({ cameras: ['Front'] }); });
    await waitFor(() => expect(result.current.events.map(e => e.id)).toEqual(['front-1']));

    await act(async () => { stale.resolve({ events: [{ id: 'back-1', camera: 'Back' }], total: 1, nextCursor: null }); });
    expect(result.current.events.map(e => e.id)).toEqual(['front-1']);
  });

  it('restarts a first load that is still running', async (ctx) => {
    story(ctx, 'Jeśli pierwsze ładowanie jeszcze trwa (zapytanie wisi), odświeżenie co 60 s zaczyna je od nowa. Zawieszone zapytanie nie blokuje siatki na zawsze, a jego spóźniona odpowiedź jest odrzucona.');
    const api = await mockedApi();
    api.getEvents.mockReset();
    const first = held();
    const second = held();
    api.getEvents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useRecordings(), { wrapper: wrapperWithUrl('/grid') });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(api.getEvents).toHaveBeenCalledTimes(1);

    await act(async () => { void refresh(result.current.loadEvents); });
    expect(api.getEvents).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    await act(async () => { second.resolve({ events: [{ id: 'new', camera: 'Front' }], total: 1, nextCursor: null }); });
    expect(result.current.events.map(e => e.id)).toEqual(['new']);
    expect(result.current.loading).toBe(false);

    await act(async () => { first.resolve({ events: [{ id: 'old', camera: 'Front' }], total: 1, nextCursor: null }); });
    expect(result.current.events.map(e => e.id)).toEqual(['new']);
  });
});
