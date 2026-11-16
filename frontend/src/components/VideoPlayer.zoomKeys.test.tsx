import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

const EVENT = {
  id: 'ev1', camera: 'Porch', timestamp: '2026-10-18T10:00:00', date: '2026-10-18', thumbnail: 't.jpg', duration: 20,
  views: [{ id: '00', videoRelPath: 'p/00.mp4', durationMs: 20000 }],
} as CameraEvent;

const zoom = vi.hoisted(() => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), resetTransform: vi.fn() }));

// The zoom surface needs real layout, which happy-dom lacks. The player's own
// key handling (the unit under test) is real; only the zoom handle is a spy.
vi.mock('./VideoZoom', () => ({
  VideoZoom: forwardRef<unknown, { children: React.ReactNode }>(function VideoZoomStub({ children }, ref) {
    useImperativeHandle(ref, () => zoom, []);
    return <div>{children}</div>;
  }),
}));

vi.mock('../api', () => ({
  api: {
    getVideoUrl: () => Promise.resolve({ videoUrl: 'blob:video', totalBytes: 1024 }),
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
  zoom.zoomIn.mockClear();
  zoom.zoomOut.mockClear();
  zoom.resetTransform.mockClear();
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
});

async function mountPlayer() {
  const { VideoPlayer } = await import('./VideoPlayer');
  render(<VideoPlayer event={EVENT} view="00" events={[EVENT]} onClose={() => {}} onNavigate={() => {}} />);
  await waitFor(() => expect(document.querySelector('.player-video')).toBeTruthy(), { timeout: 30_000 });
  // The player resets the zoom itself when a clip opens; count only what the keys do.
  zoom.zoomIn.mockClear();
  zoom.zoomOut.mockClear();
  zoom.resetTransform.mockClear();
}

describe('VideoPlayer — zoom keys', { timeout: 60_000 }, () => {
  it('[WEB-PLAYER-061] + and = zoom in, - zooms out, 0 resets the zoom', async (ctx) => {
    story(ctx, 'Podpowiedzi przycisków zoomu obiecują skróty "+", "-" i "0". Naciśnięcie ich w otwartym odtwarzaczu zbliża, oddala i resetuje obraz — tak samo jak przyciski.');
    await mountPlayer();
    fireEvent.keyDown(document, { key: '+' });
    fireEvent.keyDown(document, { key: '=' });
    expect(zoom.zoomIn).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: '-' });
    expect(zoom.zoomOut).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: '0' });
    expect(zoom.resetTransform).toHaveBeenCalledTimes(1);
  });

  it('[WEB-PLAYER-061] leaves Ctrl, Cmd and Alt combinations to the browser page zoom', async (ctx) => {
    story(ctx, 'Ctrl/Cmd +, - i 0 służą przeglądarce do zoomu całej strony. Odtwarzacz ich nie przechwytuje.');
    await mountPlayer();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      fireEvent.keyDown(document, { key: '+', ...mod });
      fireEvent.keyDown(document, { key: '-', ...mod });
      fireEvent.keyDown(document, { key: '0', ...mod });
    }
    expect(zoom.zoomIn).not.toHaveBeenCalled();
    expect(zoom.zoomOut).not.toHaveBeenCalled();
    expect(zoom.resetTransform).not.toHaveBeenCalled();
  });

  it('[WEB-PLAYER-061] ignores the keys while focus is in a text input', async (ctx) => {
    story(ctx, 'Pisanie "+" lub "0" w polu tekstowym nie zmienia zoomu odtwarzacza.');
    await mountPlayer();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '+' });
    fireEvent.keyDown(input, { key: '0' });
    input.remove();
    expect(zoom.zoomIn).not.toHaveBeenCalled();
    expect(zoom.resetTransform).not.toHaveBeenCalled();
  });
});
