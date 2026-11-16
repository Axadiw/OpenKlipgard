import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EventCard } from './EventCard';
import type { CameraEvent } from '../types';
import { useSettings } from '../context/SettingsContext';
import { story } from '../test-story';
import { clearAccountTimezone, ACCOUNT_TZ_KEY } from '../hooks/useAccountTimezone';

const ui = vi.hoisted(() => ({ language: 'en' }));

const { getEventMock } = vi.hoisted(() => ({ getEventMock: vi.fn() }));

// Mock the modules
vi.mock('../api', () => ({
  api: {
    getAccountTimezone: () => new Promise(() => {}),
    fetchThumbnailBlob: (id: string) => Promise.resolve(`blob:thumbnail-${id}`),
    getEvent: getEventMock,
  },
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
    language: ui.language,
  }),
}));

vi.mock('../context/SettingsContext', () => ({
  useSettings: vi.fn().mockReturnValue({
    settings: { thumbSize: 'M' },
    setThumbSize: vi.fn(),
  }),
}));

// Mock IntersectionObserver
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();

  vi.mocked(useSettings).mockReturnValue({
    settings: { thumbSize: 'M' },
    setThumbSize: vi.fn(),
  });

  // Make IntersectionObserver immediately trigger with isIntersecting=true
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {
      // Trigger immediately as visible
      setTimeout(() => {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }, 0);
    }
    observe = mockObserve;
    disconnect = mockDisconnect;
    unobserve = vi.fn();
  });
});

const baseEvent: CameraEvent = {
  id: 'test-id-1',
  camera: 'Front',
  timestamp: '2026-04-07T07:26:04.000Z',
  date: '2026/04/07',
  views: [
    { id: '00', videoRelPath: '2026/04/07/Front_00_20260407072604.mp4', label: 'profile.view.wide', iconKind: 'wide' },
    { id: '01', videoRelPath: '2026/04/07/Front_01_20260407072604.mp4', label: 'profile.view.zoom', iconKind: 'zoom' },
  ],
  thumbnail: '2026/04/07/Front_00_20260407072604.jpg',
};

const defaultProps = {
  event: baseEvent,
  onPlay: vi.fn(),
  isCached: vi.fn().mockReturnValue(false),
  isDownloading: vi.fn().mockReturnValue(false),
  getProgress: vi.fn().mockReturnValue(null),
  checkCached: vi.fn(),
};

afterEach(() => {
  ui.language = 'en';
  vi.useRealTimers();
  clearAccountTimezone();
});

describe('EventCard', () => {
  it('[WEB-GRID-065] formats the clock time in the interface language, not the browser locale', (ctx) => {
    story(ctx, 'Zegarek na karcie szedł według języka przeglądarki, a nagłówek dnia i „x minut temu” według języka aplikacji — karta mogła mieszać dwa formaty. Teraz godzina idzie w języku aplikacji: angielski 12-godzinny, niemiecki 24-godzinny, a klingoński czyta się jak angielski.');
    const afternoon = { ...baseEvent, timestamp: '2026-04-07T15:26:04.000Z' };
    ui.language = 'en';
    const en = render(<EventCard {...defaultProps} event={afternoon} />);
    expect(document.querySelector('.event-time')?.textContent).toMatch(/03:26\s?PM/);
    en.unmount();
    ui.language = 'de';
    const de = render(<EventCard {...defaultProps} event={afternoon} />);
    expect(document.querySelector('.event-time')?.textContent).toMatch(/^15:26/);
    de.unmount();
    ui.language = 'tlh';
    render(<EventCard {...defaultProps} event={afternoon} />);
    expect(document.querySelector('.event-time')?.textContent).toMatch(/03:26\s?PM/);
  });

  it.for([
    ['UTC', true],
    ['Asia/Tokyo', false],
  ] as const)('[WEB-GRID-065] shows the relative time only for today on the account clock (%s)', ([accountTz, expectRelative], ctx) => {
    story(ctx, 'Relatywny czas pojawia się tylko przy nagraniach „z dzisiaj”, a dzień to dzień na zegarze konta, nie przeglądarki. O 20:00 UTC w Tokio jest już następny dzień, więc nagranie z 7 kwietnia nie jest tam dzisiejsze.');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-07T20:00:00.000Z'));
    clearAccountTimezone();
    localStorage.setItem(ACCOUNT_TZ_KEY, accountTz);
    render(<EventCard {...defaultProps} />);
    expect(!!document.querySelector('.event-time .time-ago')).toBe(expectRelative);
  });

  it('renders camera name badge', (ctx) => {
    story(ctx, 'Użytkownik od razu widzi, z której kamery pochodzi nagranie — nazwa kamery jest wyraźną etykietą na karcie eventu.');
    render(<EventCard {...defaultProps} />);
    expect(screen.getByText('Front')).toBeInTheDocument();
  });

  it('tints the camera badge with the camera color (matches the timeline)', (ctx) => {
    story(ctx, 'Etykieta z nazwą kamery na karcie eventu jest pokolorowana kolorem kamery — tak samo jak na osi czasu — więc użytkownik rozpoznaje kamerę po tym samym kolorze w obu widokach.');
    render(<EventCard {...defaultProps} cameraColor="#ff0000" />);
    const badge = screen.getByText('Front');
    expect(badge).toHaveClass('camera-badge');
    expect(badge).toHaveStyle({ background: '#ff0000' });
  });

  it('leaves the camera badge un-tinted when no cameraColor is given', (ctx) => {
    story(ctx, 'Bez przekazanego koloru kamery etykieta zachowuje domyślny wygląd — kolorowanie jest dodatkiem, nie wymogiem, więc karta działa też bez palety.');
    render(<EventCard {...defaultProps} />);
    const badge = screen.getByText('Front');
    expect(badge.style.background).toBe('');
  });

  it('renders clock time', (ctx) => {
    story(ctx, 'Użytkownik przeglądając listę nagrań widzi dokładny czas zdarzenia — kluczowa informacja przy analizie wydarzeń z danego dnia.');
    render(<EventCard {...defaultProps} />);
    const timeEl = document.querySelector('.event-time');
    expect(timeEl).toBeInTheDocument();
    // Should contain a time like HH:MM
    expect(timeEl?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('renders wide and zoom view buttons when both videos exist', (ctx) => {
    story(ctx, 'Gdy kamera ma dwa obiektywy, użytkownik ma wybór między szerokim kadrem a zbliżeniem — oba przyciski są dostępne na karcie.');
    render(<EventCard {...defaultProps} />);
    // Both view buttons should be present
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(2); // wide + zoom
  });

  it('hides view picker when only wide video exists', (ctx) => {
    story(ctx, 'Gdy dostępne jest tylko nagranie z szerokiego obiektywu, przycisk wyboru obiektywu jest ukryty — miniaturka zajmuje całe pole, interfejs jest czystszy.');
    const event = { ...baseEvent, views: baseEvent.views.filter(l => l.id !== '01') };
    render(<EventCard {...defaultProps} event={event} />);
    // No view picker buttons rendered
    expect(document.querySelectorAll('.btn-view').length).toBe(0);
  });

  it('hides view picker when only zoom video exists', (ctx) => {
    story(ctx, 'Analogicznie, jeśli jest tylko zoom, przycisk wyboru obiektywu też jest ukryty — użytkownik nie widzi przycisków prowadzących donikąd.');
    const event = { ...baseEvent, views: baseEvent.views.filter(l => l.id !== '00') };
    render(<EventCard {...defaultProps} event={event} />);
    // No view picker buttons rendered
    expect(document.querySelectorAll('.btn-view').length).toBe(0);
  });

  it('calls onPlay with wide view when thumbnail is clicked', async (ctx) => {
    story(ctx, 'Kliknięcie w miniaturę uruchamia odtwarzacz z szerokiego kadru — najbardziej intuicyjny, szybki dostęp do treści bez dodatkowych wyborów.');
    const onPlay = vi.fn();
    render(<EventCard {...defaultProps} onPlay={onPlay} />);
    const img = await screen.findByRole('img');
    fireEvent.click(img);
    expect(onPlay).toHaveBeenCalledWith(baseEvent, '00');
  });

  it('calls onPlay with zoom when thumbnail clicked and no wide video', (ctx) => {
    story(ctx, 'Gdy kamera udostępnia wyłącznie zoom, kliknięcie w miniaturę otwiera dostępne nagranie — użytkownik nigdy nie trafia w puste kliknięcie.');
    const onPlay = vi.fn();
    const event = { ...baseEvent, views: baseEvent.views.filter(l => l.id !== '00') };
    render(<EventCard {...defaultProps} event={event} onPlay={onPlay} />);
    // Click the thumbnail div (no img because of visibility timing)
    const thumbnail = document.querySelector('.event-thumbnail');
    if (thumbnail) fireEvent.click(thumbnail);
    expect(onPlay).toHaveBeenCalledWith(event, '01');
  });

  it('renders play icon for events without thumbnail', (ctx) => {
    story(ctx, 'Gdy miniatura jeszcze nie powstała, użytkownik zamiast pustego prostokąta widzi ikonę play — karta pozostaje wizualnie kompletna i klikalna.');
    const event = { ...baseEvent, thumbnail: null };
    render(<EventCard {...defaultProps} event={event} />);
    expect(document.querySelector('.no-thumbnail')).toBeInTheDocument();
  });

  it('sets up IntersectionObserver', (ctx) => {
    story(ctx, 'Miniatury ładują się dopiero wtedy, gdy karta pojawia się w widoku — oszczędza to transfer i sprawia, że przewijanie długiej listy jest płynne.');
    render(<EventCard {...defaultProps} />);
    expect(mockObserve).toHaveBeenCalled();
  });

  it('hides view button when only one view exists', (ctx) => {
    story(ctx, 'Gdy kamera ma tylko jeden obiektyw, przycisk wyboru obiektywu jest zawsze ukryty — interfejs jest czystszy i miniaturka zajmuje całe pole.');
    const event = { ...baseEvent, views: baseEvent.views.filter(l => l.id !== '01') };
    render(<EventCard {...defaultProps} event={event} />);
    // No view picker buttons rendered when only one view is available
    expect(document.querySelectorAll('.btn-view').length).toBe(0);
  });

  it('renders thumbnail-unavailable placeholder when thumbnailFailed flag is set', (ctx) => {
    story(ctx, 'Po wyczerpaniu budżetu prób miniatury backend zwraca event z flagą thumbnailFailed=true — zamiast pustej kafli użytkownik widzi placeholder z dymkiem "thumbnail unavailable", a nagranie nadal można odtworzyć (mp4 fallback).');
    const event: CameraEvent = { ...baseEvent, thumbnail: '__unplayable__', thumbnailFailed: true };
    render(<EventCard {...defaultProps} event={event} />);
    const placeholder = document.querySelector('.no-thumbnail');
    expect(placeholder).toBeInTheDocument();
    expect(placeholder?.getAttribute('title')).toBe('events.thumbnail_unplayable');
  });

  it('renders thumbnail-unavailable placeholder for legacy thumbnail=__unplayable__ without flag', (ctx) => {
    story(ctx, 'Backwards-compat: jeżeli backend nie wystawi jeszcze flagi thumbnailFailed, ale w polu thumbnail siedzi sentinel "__unplayable__", frontend i tak rozpoznaje stan i renderuje placeholder — żeby fronty starsze niż backend nie pokazywały śmieciowej nazwy.');
    const event: CameraEvent = { ...baseEvent, thumbnail: '__unplayable__' };
    render(<EventCard {...defaultProps} event={event} />);
    const placeholder = document.querySelector('.no-thumbnail');
    expect(placeholder).toBeInTheDocument();
    expect(placeholder?.getAttribute('title')).toBe('events.thumbnail_unplayable');
  });

  describe('missing-thumbnail poll', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      getEventMock.mockReset();
      getEventMock.mockResolvedValue({ event: { id: 'test-id-1', thumbnail: null } });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('[WEB-GRID-062] polls the event detail every 3 s while the thumbnail is missing', (ctx) => {
      story(ctx, 'Świeżo wgrane nagranie nie ma jeszcze miniatury — karta w widoku co 3 s pyta serwer o szczegóły zdarzenia, żeby pokazać miniaturę, gdy tylko powstanie.');
      render(<EventCard {...defaultProps} event={{ ...baseEvent, thumbnail: null }} />);
      act(() => { vi.advanceTimersByTime(1); }); // observer callback marks the card visible
      act(() => { vi.advanceTimersByTime(9000); });
      expect(getEventMock).toHaveBeenCalledTimes(3);
    });

    it('[WEB-GRID-062] never polls when the server flags the thumbnail as failed without a value', (ctx) => {
      story(ctx, 'Serwer oznaczył miniaturę jako trwale nieudaną (thumbnailFailed), ale nie ustawił żadnej wartości miniatury — karta pokazuje przekreślony placeholder i przestaje odpytywać serwer, zamiast pytać co 3 s w nieskończoność.');
      render(<EventCard {...defaultProps} event={{ ...baseEvent, thumbnail: null, thumbnailFailed: true }} />);
      act(() => { vi.advanceTimersByTime(1); });
      act(() => { vi.advanceTimersByTime(30000); });
      expect(getEventMock).not.toHaveBeenCalled();
      expect(document.querySelector('.no-thumbnail')?.getAttribute('title')).toBe('events.thumbnail_unplayable');
    });

    it('[WEB-GRID-062] stops polling once the detail reports the unplayable sentinel', async (ctx) => {
      story(ctx, 'Podczas odpytywania serwer zwraca znacznik __unplayable__ — karta przełącza się na przekreślony placeholder i kończy odpytywanie.');
      getEventMock.mockResolvedValue({ event: { id: 'test-id-1', thumbnail: '__unplayable__' } });
      render(<EventCard {...defaultProps} event={{ ...baseEvent, thumbnail: null }} />);
      act(() => { vi.advanceTimersByTime(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(getEventMock).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(getEventMock).toHaveBeenCalledTimes(1);
    });
  });
});
