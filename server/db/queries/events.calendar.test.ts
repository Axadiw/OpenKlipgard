import { describe, it, expect, vi } from 'vitest';

vi.mock('../index.js', () => ({ db: {} }));
const { foldCalendarByCamera } = await import('./events.js');

describe('foldCalendarByCamera [API-EVENTS-042]', () => {
  it('folds per-(date, camera) rows into days with per-camera counts, in date order', () => {
    const days = foldCalendarByCamera([
      { date: '2026/11/12', camera: 'Front', count: 3 },
      { date: '2026/11/10', camera: 'Back', count: 1 },
      { date: '2026/11/12', camera: 'Back', count: 2 },
    ]);
    expect(days).toEqual([
      { date: '2026-11-10', count: 1, cameraCount: 1, cameras: { Back: 1 } },
      { date: '2026-11-12', count: 5, cameraCount: 2, cameras: { Front: 3, Back: 2 } },
    ]);
  });

  it('returns no days for no rows', () => {
    expect(foldCalendarByCamera([])).toEqual([]);
  });
});
