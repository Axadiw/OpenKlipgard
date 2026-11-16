import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import { story } from '../testing/story.js';

type Mod = typeof import('./mdatCache.js');

async function load(env: Record<string, string> = {}): Promise<Mod> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const m = await import('./mdatCache.js');
  m._resetMdatCacheForTests();
  return m;
}

const MiB = 1024 * 1024;
const bufStream = (n: number): Readable => Readable.from([Buffer.alloc(n, 7)]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mdatCache — fill policy', () => {
  let m: Mod;
  beforeEach(async () => {
    m = await load();
  });

  it('allowFill:false on a miss never calls the fetcher', async (ctx) => {
    story(ctx, 'Zapytanie o jeden bajt nie może wymusić pobrania całej strefy mdat z magazynu: bez zgody na wypełnienie cache nie woła fetchera.');
    const fetcher = vi.fn(async () => bufStream(1024));
    const r = await m.getCachedMdat('k1', 1024, fetcher, { allowFill: false });
    expect(r).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(m._getInflightBytesForTests()).toBe(0);
  });

  it('a hit is returned even with allowFill:false', async (ctx) => {
    story(ctx, 'Gorąca ścieżka bez zmian: gdy strefa jest już w pamięci, małe zapytanie jest z niej obsłużone bez żadnego wywołania S3.');
    const fetcher = vi.fn(async () => bufStream(1024));
    const first = await m.getCachedMdat('k2', 1024, fetcher);
    expect(first?.length).toBe(1024);
    const second = await m.getCachedMdat('k2', 1024, fetcher, { allowFill: false });
    expect(second?.length).toBe(1024);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allowFill:false still joins a fill that is already running', async (ctx) => {
    story(ctx, 'Jeśli ktoś już pobiera strefę, małe zapytanie dołącza do tego pobierania zamiast iść osobno do S3.');
    const body = new Readable({ read() {} });
    const push = (b: Buffer | null) => body.push(b);
    const fetcher = vi.fn(async () => body);
    const filler = m.getCachedMdat('k3', 1024, fetcher);
    await Promise.resolve();
    const joiner = m.getCachedMdat('k3', 1024, fetcher, { allowFill: false });
    push(Buffer.alloc(1024));
    push(null);
    expect((await joiner)?.length).toBe(1024);
    expect((await filler)?.length).toBe(1024);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('mdatCache — in-flight budget', () => {
  it('concurrent fills beyond the in-flight budget return null without fetching', async (ctx) => {
    story(ctx, 'Seria zimnych zapytań o różne pliki nie może jednocześnie buforować w pamięci więcej niż limit: nadmiarowe dostają null i idą zwykłym zakresowym GET.');
    const m = await load({ MDAT_CACHE_MAX_INFLIGHT_BYTES: String(3 * MiB) });
    const bodies: Readable[] = [];
    const fetcher = vi.fn(async () => {
      const r = new Readable({ read() {} });
      bodies.push(r);
      return r;
    });
    const a = m.getCachedMdat('a', 2 * MiB, fetcher);
    await Promise.resolve();
    expect(m._getInflightBytesForTests()).toBe(2 * MiB);
    const b = await m.getCachedMdat('b', 2 * MiB, fetcher);
    expect(b).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    bodies[0].push(Buffer.alloc(16));
    bodies[0].push(null);
    expect((await a)?.length).toBe(16);
    expect(m._getInflightBytesForTests()).toBe(0);

    // Budget is free again.
    const c = m.getCachedMdat('c', 2 * MiB, async () => bufStream(8));
    expect((await c)?.length).toBe(8);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('mdatCache — abort', () => {
  it('when the only waiter aborts, the fill is aborted and nothing is cached', async (ctx) => {
    story(ctx, 'Klient, który się rozłączył, nie zostawia za sobą pobierania całej strefy: ostatni oczekujący anuluje fill, nic nie trafia do cache, a budżet wraca.');
    const m = await load();
    let seen: AbortSignal | undefined;
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      return new Readable({ read() {} }); // never ends
    });
    const ac = new AbortController();
    const p = m.getCachedMdat('z', 1024, fetcher, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(m._getInflightBytesForTests()).toBe(1024);
    ac.abort();
    expect(await p).toBeNull();
    expect(seen?.aborted).toBe(true);
    expect(m._getInflightBytesForTests()).toBe(0);

    // Nothing cached: a second call fetches again.
    const again = await m.getCachedMdat('z', 1024, async () => bufStream(1024));
    expect(again?.length).toBe(1024);
  });

  it('a fill survives one waiter leaving while another still waits', async (ctx) => {
    story(ctx, 'Gdy jeden z dwóch klientów czekających na to samo pobranie się rozłączy, drugi nadal dostaje dane.');
    const m = await load();
    const body = new Readable({ read() {} });
    const fetcher = vi.fn(async () => body);
    const ac = new AbortController();
    const p1 = m.getCachedMdat('y', 64, fetcher, { signal: ac.signal });
    const p2 = m.getCachedMdat('y', 64, fetcher);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await p1).toBeNull();
    body.push(Buffer.alloc(64));
    body.push(null);
    expect((await p2)?.length).toBe(64);
  });
});
