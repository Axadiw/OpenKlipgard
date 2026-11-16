import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const { mockSetDiskUsageAbsolute } = vi.hoisted(() => ({ mockSetDiskUsageAbsolute: vi.fn() }));

vi.mock('../config.js', () => ({ CONFIG: { s3RecordingsBucket: 'rec' } }));
vi.mock('../db/queries/storage.js', () => ({
  setDiskUsageAbsolute: (...a: unknown[]) => mockSetDiskUsageAbsolute(...a),
}));
vi.mock('./s3.js', () => ({ listObjectsStream: vi.fn() }));

import { sumRecordingsBytes, syncDiskUsageFromListing } from './diskUsageFromListing.js';

async function* objects(sizes: number[]) {
  for (const size of sizes) yield { key: `k${size}`, size };
}

describe('disk usage from the bucket listing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DATA-130: sums every listed object of the account prefix, markers as 0 bytes', async (ctx) => {
    story(ctx, 'Zużycie dysku = suma rozmiarów obiektów z listingu prefiksu konta w buckecie nagrań; marker katalogu (0 B) nic nie dodaje.');
    const list = vi.fn((_bucket: string, _prefix: string) => objects([100, 0, 250]));

    const total = await sumRecordingsBytes('u-1', list);

    expect(total).toBe(350);
    expect(list).toHaveBeenCalledWith('rec', 'u-1/');
  });

  it('DATA-130: sets the counter to the listed total', async (ctx) => {
    story(ctx, 'Po usunięciu treści licznik dysku dostaje wartość z listingu, taką samą, jaką ustawiłby reconciler.');
    const total = await syncDiskUsageFromListing(7, 'u-7', () => objects([40, 2]));

    expect(total).toBe(42);
    expect(mockSetDiskUsageAbsolute).toHaveBeenCalledWith(7, 42);
  });

  it('DATA-130: keeps the counter when the listing fails', async (ctx) => {
    story(ctx, 'Awaria listingu nie zeruje ani nie psuje licznika: zostaje wartość dotychczasowa do najbliższej rekoncyliacji.');
    const failing = async function* () { throw new Error('list down'); yield { size: 1 }; };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const total = await syncDiskUsageFromListing(7, 'u-7', failing);

    expect(total).toBeNull();
    expect(mockSetDiskUsageAbsolute).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
