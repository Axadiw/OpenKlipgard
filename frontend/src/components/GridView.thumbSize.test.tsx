import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';

const { setThumbSize } = vi.hoisted(() => ({ setThumbSize: vi.fn() }));

vi.mock('../api', () => ({ api: {} }));
vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));
vi.mock('../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { thumbSize: 'M' }, setThumbSize }),
}));
vi.mock('../hooks/useRecordings', () => ({
  useRecordings: () => ({
    cameras: [], events: [], total: 0, filters: {}, hasActiveFilter: false, hasMore: false,
    loading: false, loadingMore: false,
    loadCameras: vi.fn(), loadEvents: vi.fn(), loadMore: vi.fn(), updateFilters: vi.fn(),
  }),
}));
vi.mock('./AuthedShell', () => ({
  useShell: () => ({ openPlayer: vi.fn(), setBulkDelete: vi.fn(), setBulkDeleteOnDone: vi.fn() }),
}));
vi.mock('./FilterBar', () => ({ FilterBar: () => null }));
vi.mock('./EventList', () => ({ EventList: () => null }));
vi.mock('./ProcessingStatusIndicator', () => ({ ProcessingStatusIndicator: () => null }));

describe('GridView — thumbnail size buttons', () => {
  it('[WEB-GRID-080] gives each size button its own tooltip', async (ctx) => {
    story(ctx, 'Trzy przyciski rozmiaru miniatury miały ten sam tooltip („Siatka”), więc kto polega na podpowiedziach nie odróżniał małego od dużego. Każdy ma teraz własny klucz; „Siatka” nie wraca na żaden z nich (przełącznik widoku jest w nagłówku).');
    const { GridView } = await import('./GridView');
    renderWithRouter(<GridView />, { route: '/grid' });

    const small = screen.getByTitle('events.thumbSizeS');
    const medium = screen.getByTitle('events.thumbSizeM');
    const large = screen.getByTitle('events.thumbSizeL');
    expect(new Set([small, medium, large]).size).toBe(3);
    expect(screen.queryAllByTitle('view.grid')).toHaveLength(0);

    fireEvent.click(large);
    expect(setThumbSize).toHaveBeenCalledWith('L');
  });
});
