import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

const EVENT = {
  id: 'ev1', camera: 'Porch', timestamp: '2026-10-18T10:00:00', date: '2026-10-18', thumbnail: 't.jpg', duration: 20,
  views: [{ id: '00', videoRelPath: 'p/00.mp4', durationMs: 20000 }],
} as CameraEvent;

vi.mock('../api', () => ({
  api: {
    // Never settles: the player stays in its first-load state.
    getVideoUrl: () => new Promise(() => {}),
    getFrameGrid: () => Promise.resolve([]),
    fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
    downloadVideo: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
});

describe('VideoPlayer — labels come from the catalog', () => {
  it('[WEB-PLAYER-023] the load overlay and the header tooltips use translation keys', async (ctx) => {
    story(ctx, 'Komunikat „Loading video…” i podpowiedzi „Download” oraz „Close” były wpisane po angielsku, choć klucz player.download już istniał. Wszystkie idą teraz przez katalog, więc przełączenie języka je tłumaczy.');
    const { VideoPlayer } = await import('./VideoPlayer');
    render(<VideoPlayer event={EVENT} view="00" events={[EVENT]} onClose={() => {}} onNavigate={() => {}} />);

    expect(await screen.findByText('player.loadingVideo')).toBeTruthy();
    expect(screen.getByTitle('player.download')).toBeTruthy();
    expect(screen.getByTitle('player.close')).toBeTruthy();
    expect(screen.queryByText('Loading video…')).toBeNull();
  }, 30_000);
});
