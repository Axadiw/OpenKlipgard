import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'buffer';
import { Readable } from 'stream';
import { story } from '../testing/story.js';
import { buildSidecar } from '../services/mp4/sidecar.js';
import { makeFtyp, makeMoov, makeMoofMdat } from '../services/mp4/__test-fixtures.js';

// In-memory object store: sidecars bucket and recordings bucket share one map,
// keyed "<bucket>/<key>". The scan query is a fixed list of rows.
const store = new Map<string, Buffer>();
const puts: string[] = [];
const calls = { get: 0, head: 0, put: 0 };
let rows: { id: number; s3Bucket: string; s3Key: string; encryptionSalt: string | null }[] = [];
let failGetFor: string | null = null;

vi.mock('../services/s3.js', () => ({
  getObject: vi.fn(async (bucket: string, key: string, _salt: string, range?: string) => {
    calls.get++;
    if (failGetFor && key === failGetFor) throw new Error('socket timeout');
    const buf = store.get(`${bucket}/${key}`);
    if (!buf) {
      const e = new Error('NoSuchKey') as Error & { name: string };
      e.name = 'NoSuchKey';
      throw e;
    }
    let out = buf;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range)!;
      out = buf.subarray(Number(m[1]), Number(m[2]) + 1);
    }
    return { body: Readable.from([out]) };
  }),
  headObject: vi.fn(async (bucket: string, key: string) => {
    calls.head++;
    const buf = store.get(`${bucket}/${key}`);
    if (!buf) throw new Error('NoSuchKey');
    return { contentLength: buf.length, lastModified: new Date() };
  }),
  putObject: vi.fn(async (bucket: string, key: string, body: Buffer) => {
    calls.put++;
    puts.push(`${bucket}/${key}`);
    store.set(`${bucket}/${key}`, body);
  }),
}));

vi.mock('../db/queries/events.js', () => ({
  getReadyFilesBeforeAfterId: vi.fn(async (afterId: number, _before: Date, limit: number) =>
    rows.filter((r) => r.id > afterId).slice(0, limit)),
}));

const { runRebuild, parseArgs } = await import('./rebuild-old-sidecars.js');
const { CONFIG } = await import('../config.js');
const { parseSidecar } = await import('../services/mp4/sidecar.js');
const { inspectMoov } = await import('../services/mp4/moov.js');

const REC = CONFIG.s3RecordingsBucket;
const SC = CONFIG.s3SidecarsBucket;

function recording(withMehd: boolean): Buffer {
  const moov = makeMoov({
    mvhdTimescale: 1000,
    mvhdDuration: withMehd ? 5000 : 0,
    tracks: [{ id: 1, mdhdTimescale: 90000 }],
    withMvex: true,
    withMehd,
    trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
  });
  return Buffer.concat([
    makeFtyp(),
    moov,
    makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000, 3000], mdatPayloadSize: 128 }),
    makeMoofMdat({ trackId: 1, decodeTime: 6000, sampleDurations: [3000, 3000], mdatPayloadSize: 128 }),
  ]);
}

function oldSidecar(): Buffer {
  const prelude = Buffer.concat([
    makeFtyp(),
    makeMoov({
      mvhdTimescale: 1000, mvhdDuration: 0, tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true, withMehd: true, trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    }),
  ]);
  return buildSidecar(prelude, Buffer.alloc(16, 1), 1000);
}

function addRow(id: number, sidecar: Buffer | null, rec: Buffer | null = recording(false)): void {
  const key = `uuid/2026/04/clip${id}.mp4`;
  rows.push({ id, s3Bucket: REC, s3Key: key, encryptionSalt: 'salt' });
  if (rec) store.set(`${REC}/${key}`, rec);
  if (sidecar) store.set(`${SC}/${key}.fmp4patch`, sidecar);
}

beforeEach(() => {
  store.clear();
  puts.length = 0;
  rows = [];
  failGetFor = null;
  calls.get = calls.head = calls.put = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runRebuild [WORKER-086] [WORKER-087] [WORKER-088] [WORKER-089]', () => {
  it('[WORKER-087] replaces a mehd sidecar with one that has no mehd, and the rerun finds nothing to do', async (ctx) => {
    story(ctx, 'A recording with an old mehd sidecar gets a rebuilt sidecar. A second run does not touch it again.');
    addRow(1, oldSidecar());
    const first = await runRebuild(parseArgs([]));
    expect(first).toMatchObject({ scanned: 1, mehd: 1, rebuilt: 1, failed: 0 });
    expect(puts).toEqual([`${SC}/uuid/2026/04/clip1.mp4.fmp4patch`]);
    const rebuilt = parseSidecar(store.get(`${SC}/uuid/2026/04/clip1.mp4.fmp4patch`)!);
    expect(inspectMoov(rebuilt.prelude).moov.hasMehd).toBe(false);

    const second = await runRebuild(parseArgs([]));
    expect(second).toMatchObject({ scanned: 1, mehd: 0, current: 1, rebuilt: 0 });
    expect(puts).toHaveLength(1);
  });

  it('[WORKER-089] a dry run reads sidecars, counts each kind and writes nothing', async () => {
    addRow(1, oldSidecar());
    addRow(2, null); // class B or C: no sidecar
    addRow(3, Buffer.from('garbage-garbage-garbage'));
    const c = await runRebuild(parseArgs(['--dry-run']));
    expect(c).toMatchObject({ scanned: 3, mehd: 1, missing: 1, unreadable: 1, rebuilt: 1, failed: 0 });
    expect(calls.put).toBe(0);
    expect(calls.head).toBe(0); // no recording read at all
  });

  it('[WORKER-088] an S3 error skips the row, counts a failure and leaves the object alone', async () => {
    addRow(1, oldSidecar());
    addRow(2, oldSidecar());
    failGetFor = 'uuid/2026/04/clip1.mp4.fmp4patch';
    const before = store.get(`${SC}/uuid/2026/04/clip1.mp4.fmp4patch`);
    const c = await runRebuild(parseArgs([]));
    expect(c).toMatchObject({ scanned: 2, failed: 1, rebuilt: 1 });
    expect(store.get(`${SC}/uuid/2026/04/clip1.mp4.fmp4patch`)).toBe(before);
  });

  it('[WORKER-087] does not write when the recording itself has a mehd box (not class A)', async () => {
    addRow(1, oldSidecar(), recording(true));
    const c = await runRebuild(parseArgs([]));
    expect(c).toMatchObject({ mehd: 1, rejected: 1, rebuilt: 0 });
    expect(calls.put).toBe(0);
  });

  it('[WORKER-087] leaves a pre-v6 sidecar alone unless asked', async () => {
    const preV6 = buildSidecar(
      Buffer.concat([makeFtyp(), makeMoov({
        mvhdTimescale: 1000, mvhdDuration: 0, tracks: [{ id: 1, mdhdTimescale: 90000 }],
        withMvex: true, withMehd: false, trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
      })]),
      Buffer.alloc(16, 1),
      1000,
    );
    addRow(1, preV6);
    expect(await runRebuild(parseArgs([]))).toMatchObject({ preV6: 1, rebuilt: 0 });
    expect(calls.put).toBe(0);
    expect(await runRebuild(parseArgs(['--include-pre-v6']))).toMatchObject({ preV6: 1, rebuilt: 1 });
    expect(calls.put).toBe(1);
  });

  it('[WORKER-089] --max-scan, --max-rebuild and --after-id bound and resume a run', async () => {
    for (let i = 1; i <= 5; i++) addRow(i, oldSidecar());
    expect((await runRebuild(parseArgs(['--dry-run', '--max-scan', '2']))).scanned).toBe(2);
    expect((await runRebuild(parseArgs(['--max-rebuild', '3']))).rebuilt).toBe(3);
    // Rows 1-3 are rebuilt now. Resume after id 3 finds the remaining two.
    const resumed = await runRebuild(parseArgs(['--after-id', '3']));
    expect(resumed).toMatchObject({ scanned: 2, rebuilt: 2 });
  });
});
