import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVideoStallRetry } from './useVideoStallRetry';
import { story } from '../test-story';

vi.mock('../lib/errorReporting', () => ({ addBreadcrumb: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));

// Only the element is faked: the hook's listeners, timers and state are real.
class FakeVideo extends EventTarget {
  currentTime = 0;
  buffered = { length: 0, end: () => 0 };
  error: { code: number } | null = null;
  src = '';
  load = vi.fn();
  fail(code: number) {
    this.error = { code };
    this.dispatchEvent(new Event('error'));
  }
  play() {
    this.dispatchEvent(new Event('playing'));
  }
}

let video: FakeVideo;

beforeEach(() => {
  vi.useFakeTimers();
  video = new FakeVideo();
});
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const videoRef = { current: video as unknown as HTMLVideoElement };
  return renderHook(() => useVideoStallRetry(videoRef, 'blob:clip'));
}

describe('useVideoStallRetry — the "retrying" state', () => {
  it('[WEB-PLAYER-113] clears the retrying state when the retried load reaches playing', (ctx) => {
    story(ctx, 'Po błędzie sieci odtwarzacz ponawia ładowanie. Gdy ponowione ładowanie zacznie grać, komunikat "ponawiam…" znika, zamiast wisieć do zamknięcia odtwarzacza.');
    const { result } = setup();
    act(() => { video.fail(2); });
    expect(result.current.retrying).toBe(true);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(result.current.retrying).toBe(true);
    expect(result.current.retryCount).toBe(1);
    act(() => { video.play(); });
    expect(result.current.retrying).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it('[WEB-PLAYER-113] drops a retry that is still scheduled when the video starts playing', (ctx) => {
    story(ctx, 'Jeśli wideo zacznie grać, zanim odliczanie do ponowienia dobiegnie końca, ponowienie nie rusza źródła grającego już wideo.');
    const { result } = setup();
    act(() => { video.fail(3); });
    expect(result.current.retrying).toBe(true);
    act(() => { video.play(); });
    expect(result.current.retrying).toBe(false);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(video.load).not.toHaveBeenCalled();
    expect(result.current.retrying).toBe(false);
  });
});
