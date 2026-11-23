import { describe, it, expect, vi } from 'vitest';
import { story } from '../test-story';
import { fitHeaderLabels, rowFits, type LabelFit } from './useHeaderLabelFit';

/** A header with a view switch and an actions block, the way the shell lays them out. */
function mountHeader() {
  const header = document.createElement('header');
  header.className = 'app-header';
  const nav = document.createElement('nav');
  const actions = document.createElement('div');
  header.append(nav, actions);
  document.body.append(header);
  return { header, nav, actions };
}

/** What the row needs in each label mode, in px, and what the phone offers. */
function rowNeeding(need: Record<LabelFit, number>, offered: number) {
  return (nav: HTMLElement) => (_header: HTMLElement) => need[nav.dataset.labels as LabelFit] <= offered;
}

describe('fitHeaderLabels [WEB-SHELL-080]', () => {
  it('keeps both labels when the row has room for both', (ctx) => {
    story(ctx, 'Na szerokim telefonie oba podpisy przełącznika widoku (Nagrania, Oś czasu) zostają widoczne.');
    const { nav } = mountHeader();
    const mode = fitHeaderLabels(nav, rowNeeding({ both: 380, current: 330, none: 250 }, 390)(nav));
    expect(mode).toBe('both');
    expect(nav.dataset.labels).toBe('both');
  });

  it('drops the label of the other item first', (ctx) => {
    story(ctx, 'Gdy oba podpisy się nie mieszczą (francuski i hiszpański na 390 px), znika podpis drugiej pozycji; podpis bieżącej zostaje.');
    const { nav } = mountHeader();
    const mode = fitHeaderLabels(nav, rowNeeding({ both: 435, current: 356, none: 250 }, 390)(nav));
    expect(mode).toBe('current');
    expect(nav.dataset.labels).toBe('current');
  });

  it('drops both labels when even the current one does not fit', (ctx) => {
    story(ctx, 'Na najwęższym telefonie (320 px) znikają oba podpisy i zostają same ikony.');
    const { nav } = mountHeader();
    const mode = fitHeaderLabels(nav, rowNeeding({ both: 435, current: 356, none: 250 }, 320)(nav));
    expect(mode).toBe('none');
    expect(nav.dataset.labels).toBe('none');
  });

  it('settles on the narrowest mode when nothing fits', (ctx) => {
    story(ctx, 'Gdy nawet same ikony się nie mieszczą, przełącznik zostaje w najwęższym trybie zamiast wracać do szerszego.');
    const { nav } = mountHeader();
    expect(fitHeaderLabels(nav, () => false)).toBe('none');
    expect(nav.dataset.labels).toBe('none');
  });

  it('measures again from the widest mode each time', (ctx) => {
    story(ctx, 'Po obróceniu telefonu albo rozciągnięciu okna podpisy wracają, gdy znów jest na nie miejsce.');
    const { nav } = mountHeader();
    const need = { both: 435, current: 356, none: 250 };
    expect(fitHeaderLabels(nav, rowNeeding(need, 320)(nav))).toBe('none');
    expect(fitHeaderLabels(nav, rowNeeding(need, 400)(nav))).toBe('current');
    expect(fitHeaderLabels(nav, rowNeeding(need, 480)(nav))).toBe('both');
  });

  it('does nothing for a switch that is not inside the header', (ctx) => {
    story(ctx, 'Przełącznik poza nagłówkiem nie dostaje żadnego trybu: nie ma czego mierzyć.');
    const nav = document.createElement('nav');
    expect(fitHeaderLabels(nav, () => false)).toBe('both');
    expect(nav.dataset.labels).toBeUndefined();
  });
});

describe('rowFits [WEB-SHELL-080]', () => {
  function sized(opts: { scroll: number; client: number; headerRight: number; lastRight: number; padRight?: string }) {
    const { header, actions } = mountHeader();
    header.style.paddingRight = opts.padRight ?? '10px';
    Object.defineProperty(header, 'scrollWidth', { configurable: true, value: opts.scroll });
    Object.defineProperty(header, 'clientWidth', { configurable: true, value: opts.client });
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ right: opts.headerRight } as DOMRect);
    vi.spyOn(actions, 'getBoundingClientRect').mockReturnValue({ right: opts.lastRight } as DOMRect);
    return header;
  }

  it('is false when the row scrolls sideways', (ctx) => {
    story(ctx, 'Wiersz nagłówka, który wystaje poza ekran (przewija się na boki), nie mieści podpisów.');
    expect(rowFits(sized({ scroll: 397, client: 390, headerRight: 390, lastRight: 387 }))).toBe(false);
  });

  it('is false when the last item sits in the right padding', (ctx) => {
    story(ctx, 'Ostatni przycisk nagłówka (awatar) nie może wchodzić w prawy margines: wiersz ma wtedy za mało miejsca.');
    expect(rowFits(sized({ scroll: 390, client: 390, headerRight: 390, lastRight: 385 }))).toBe(false);
  });

  it('is true when the last item ends at the padding edge', (ctx) => {
    story(ctx, 'Gdy ostatni przycisk kończy się na brzegu marginesu, wiersz się mieści.');
    expect(rowFits(sized({ scroll: 390, client: 390, headerRight: 390, lastRight: 380 }))).toBe(true);
  });
});
