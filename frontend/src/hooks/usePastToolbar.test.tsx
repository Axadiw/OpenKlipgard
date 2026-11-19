import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { usePastToolbar } from './usePastToolbar';
import { story } from '../test-story';

let markerTop = 100;

function setup() {
  const marker = document.createElement('div');
  marker.getBoundingClientRect = () => ({ top: markerTop } as DOMRect);
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(marker);
    return usePastToolbar(ref);
  });
}

function scrollTo(top: number) {
  markerTop = top;
  act(() => { window.dispatchEvent(new Event('scroll')); });
}

beforeEach(() => {
  markerTop = 100;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('usePastToolbar', () => {
  it('[WEB-GRID-120] is false while the toolbar place is still in view', (ctx) => {
    story(ctx, 'Na górze strony pasek narzędzi stoi na swoim miejscu, więc dolnej belki jeszcze nie ma.');
    const { result } = setup();
    scrollTo(40);
    expect(result.current).toBe(false);
  });

  it('[WEB-GRID-120] [WEB-GRID-121] is true past the toolbar in both scroll directions', (ctx) => {
    story(ctx, 'Po zjechaniu poniżej paska z filtrami jest on cały czas przyklejony u góry — kierunek przewijania nic nie zmienia, a dolna belka zostaje.');
    const { result } = setup();
    scrollTo(-300);
    expect(result.current).toBe(true);
    scrollTo(-290);
    expect(result.current).toBe(true);
    scrollTo(10);
    expect(result.current).toBe(false);
  });
});
