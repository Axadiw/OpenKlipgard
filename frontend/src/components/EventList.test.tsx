import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EventList } from './EventList';
import type { CameraEvent } from '../types';
import { story } from '../test-story';
import { clearAccountTimezone, ACCOUNT_TZ_KEY } from '../hooks/useAccountTimezone';


vi.mock('../api', () => ({
  api: {
    // Never settles: the zone under test comes from the local cache the hook seeds from.
    getAccountTimezone: () => new Promise(() => {}),
    fetchThumbnailBlob: (id: string) => Promise.resolve(`blob:thumbnail-${id}`),
    getEvent: (id: string) => Promise.resolve({ event: { id, thumbnail: null } }),
  },
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'en',
  }),
}));

// The first-time empty state asks the server for its FTP details; not what
// these tests are about, so it gets none.
vi.mock('../hooks/useServerConfig', () => ({
  useServerConfig: () => null,
}));

// Nor does it get the edition's own parts of that block.
vi.mock('../edition', () => ({ edition: { cameraConnect: null } }));

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  clearAccountTimezone();
});

const baseEvent: CameraEvent = {
  id: 'e1',
  camera: 'Front',
  timestamp: '2026-04-01T10:00:00.000Z',
  date: '2026/04/01',
  views: [{ id: '00', videoRelPath: '2026/04/01/Front_00.mp4', label: 'profile.view.wide', iconKind: 'wide' }],
  thumbnail: '2026/04/01/Front_00.jpg',
};

const baseProps = {
  total: 1,
  loading: false,
  loadingMore: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  onPlay: vi.fn(),
  thumbSize: 'M' as const,
};

describe('EventList', () => {
  it('[WEB-GRID-057] names Today and Yesterday through the catalog, counted on the account clock', async (ctx) => {
    story(ctx, 'Nagłówki „Dzisiaj”/„Wczoraj” były wpisane na sztywno (tylko polski tłumaczony) i liczone z zegara przeglądarki. Teraz idą przez katalog i18n, a „dzisiaj” to dzień na zegarze konta: o 20:00 UTC w Tokio jest już 8 kwietnia, więc nagranie z 8 kwietnia jest dzisiejsze, a z 7 wczorajsze.');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-07T20:00:00.000Z'));
    clearAccountTimezone();
    localStorage.setItem(ACCOUNT_TZ_KEY, 'Asia/Tokyo');
    const events: CameraEvent[] = [
      { ...baseEvent, id: 'a', timestamp: '2026-04-08T01:00:00.000Z' },
      { ...baseEvent, id: 'b', timestamp: '2026-04-07T10:00:00.000Z' },
      { ...baseEvent, id: 'c', timestamp: '2026-04-05T10:00:00.000Z' },
    ];
    const { container } = render(<EventList events={events} {...baseProps} />);
    const headers = Array.from(container.querySelectorAll('.day-header')).map(h => h.textContent);
    expect(headers[0]).toBe('events.today');
    expect(headers[1]).toBe('events.yesterday');
    expect(headers[2]).toMatch(/Sunday, 5 April 2026/);
  });

  it('keeps day-group DOM node stable across auto-refresh re-renders even when the relative-time label shifts', (ctx) => {
    story(
      ctx,
      'Co 60s tło woła loadEvents() i siatka klipów dostaje nową referencję events[]. Dla day-groupów spoza "dzisiaj/wczoraj" nagłówek dnia zawiera relatywny czas (np. "5 days ago") liczony przez formatDistanceToNow, który po minucie może zwrócić inny string. Wcześniej React key day-groupa = pełny label → zmiana stringa unmountowała cały <div> z grupą wraz z EventCardami, kasowała blob URL thumbnaila w AuthImage i powodowała widoczny błysk szarego placeholdera. Test pilnuje, że DOM-node day-groupa przeżywa rerender z przesuniętym czasem.',
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    const ev: CameraEvent = { ...baseEvent };
    const { container, rerender } = render(<EventList events={[ev]} {...baseProps} />);

    const dayGroupBefore = container.querySelector('.event-list > div');
    expect(dayGroupBefore).toBeTruthy();
    const labelBefore = dayGroupBefore?.querySelector('.day-header')?.textContent ?? '';
    expect(labelBefore).toMatch(/ago/);

    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
    rerender(<EventList events={[{ ...ev }]} {...baseProps} />);

    const dayGroupAfter = container.querySelector('.event-list > div');
    const labelAfter = dayGroupAfter?.querySelector('.day-header')?.textContent ?? '';

    expect(labelAfter).not.toBe(labelBefore);
    expect(dayGroupAfter).toBe(dayGroupBefore);
  });

  it('shows the first-time empty state when there are no events and no active filter', (ctx) => {
    story(ctx, 'Pusta siatka bez aktywnych filtrów to świeże konto — pokazujemy onboardingowy komunikat "brak nagrań", a nie sugerujemy czyszczenia nieistniejących filtrów.');
    render(<EventList events={[]} {...baseProps} hasActiveFilter={false} />);
    expect(screen.getByText('events.emptyFirstTime.title')).toBeInTheDocument();
    expect(screen.queryByText('events.emptyFiltered.title')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'events.clearFilters' })).not.toBeInTheDocument();
  });

  it('shows the filtered empty state + working Clear filters when filters hide every recording', (ctx) => {
    story(ctx, 'Gdy aktywne filtry odsiały wszystkie nagrania, siatka pokazuje "nic nie pasuje do filtrów" + przycisk czyszczenia, który woła onClearFilters — koniec mylącego pustego stanu "brak nagrań".');
    const onClearFilters = vi.fn();
    render(<EventList events={[]} {...baseProps} hasActiveFilter onClearFilters={onClearFilters} />);
    expect(screen.getByText('events.emptyFiltered.title')).toBeInTheDocument();
    expect(screen.queryByText('events.emptyFirstTime.title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'events.clearFilters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  describe('current-day bar', () => {
    type Obs = { cb: IntersectionObserverCallback; options?: IntersectionObserverInit };
    let observers: Obs[];

    beforeEach(() => {
      observers = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            observers.push({ cb, options });
          }
          observe = vi.fn();
          disconnect = vi.fn();
          unobserve = vi.fn();
        },
      );
    });

    const newer: CameraEvent = { ...baseEvent, id: 'e2', timestamp: '2026-04-02T10:00:00.000Z', date: '2026/04/02' };

    function setHeaderTops(container: HTMLElement, tops: number[]) {
      container.querySelectorAll('.day-header').forEach((el, i) => {
        (el as HTMLElement).getBoundingClientRect = () => ({ top: tops[i] } as DOMRect);
      });
    }

    it('[WEB-GRID-059] observes the day headers against the viewport, not the non-scrolling list', (ctx) => {
      story(ctx, 'Lista dni nie przewija się sama — przewija się cała strona. Obserwator nagłówków dni musi więc patrzeć na viewport (root: null), inaczej belka "aktualny dzień" nigdy się nie pokaże.');
      render(<EventList events={[newer, baseEvent]} {...baseProps} />);
      const dayObserver = observers.find(o => Array.isArray(o.options?.threshold));
      expect(dayObserver).toBeTruthy();
      expect(dayObserver!.options!.root ?? null).toBeNull();
    });

    it('[WEB-GRID-059] shows the bar for the day group scrolled past the top, hides it for the first group', (ctx) => {
      story(ctx, 'Gdy użytkownik przewinie pierwszą grupę dnia poza górną krawędź, belka pokazuje dzień następnej grupy. Dopóki aktualna jest pierwsza grupa, belki nie ma — nie dubluje nagłówka.');
      const { container } = render(<EventList events={[newer, baseEvent]} {...baseProps} />);
      const cb = observers.find(o => Array.isArray(o.options?.threshold))!.cb;

      setHeaderTops(container, [120, 900]);
      act(() => { cb([], {} as IntersectionObserver); });
      expect(container.querySelector('.current-day-bar')).toBeNull();

      setHeaderTops(container, [-600, -5]);
      act(() => { cb([], {} as IntersectionObserver); });
      const secondLabel = container.querySelectorAll('.day-header')[1].textContent ?? '';
      expect(container.querySelector('.current-day-bar')?.textContent).toBe(secondLabel);
    });
  });

  describe('load pause', () => {
    type Obs = { cb: IntersectionObserverCallback; options?: IntersectionObserverInit };
    let observers: Obs[];

    beforeEach(() => {
      observers = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            observers.push({ cb, options });
          }
          observe = vi.fn();
          disconnect = vi.fn();
          unobserve = vi.fn();
        },
      );
    });

    const sentinelObserver = () => observers.filter(o => o.options?.rootMargin === '200px 0px').at(-1)!;
    const fire = (inZone: boolean) => act(() => {
      sentinelObserver().cb([{ isIntersecting: inZone } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    it('[WEB-GRID-125] a paused sentinel reports its zone but loads no batch', (ctx) => {
      story(ctx, 'Po „Na dół” lista ma się zatrzymać, żeby było widać stopkę: wartownik dalej mówi, czy jest w strefie, ale nie dociąga kolejnej porcji.');
      const onLoadMore = vi.fn();
      const onSentinelZone = vi.fn();
      render(<EventList events={[baseEvent]} {...baseProps} hasMore onLoadMore={onLoadMore} loadPaused onSentinelZone={onSentinelZone} />);
      fire(true);
      expect(onSentinelZone).toHaveBeenLastCalledWith(true);
      expect(onLoadMore).not.toHaveBeenCalled();
    });

    it('[WEB-GRID-050] without a pause the sentinel loads the next batch', (ctx) => {
      story(ctx, 'Bez pauzy nic się nie zmienia: wartownik w strefie 200 px dociąga kolejne 50 nagrań.');
      const onLoadMore = vi.fn();
      render(<EventList events={[baseEvent]} {...baseProps} hasMore onLoadMore={onLoadMore} />);
      fire(true);
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('[WEB-GRID-122] the current-day bar sits under a shown toolbar', (ctx) => {
      story(ctx, 'Gdy przyklejony pasek narzędzi wraca po przewinięciu w górę, belka dnia zjeżdża pod niego zamiast się z nim nakładać.');
      const newer: CameraEvent = { ...baseEvent, id: 'e2', timestamp: '2026-04-02T10:00:00.000Z', date: '2026/04/02' };
      const { container } = render(<EventList events={[newer, baseEvent]} {...baseProps} currentDayTop={41} />);
      container.querySelectorAll('.day-header').forEach((el, i) => {
        (el as HTMLElement).getBoundingClientRect = () => ({ top: [-500, -10][i] } as DOMRect);
      });
      const dayObs = observers.find(o => o.options?.rootMargin === undefined)!;
      act(() => { dayObs.cb([], {} as IntersectionObserver); });
      expect((container.querySelector('.current-day-slot') as HTMLElement).style.top).toBe('41px');
    });
  });
});
