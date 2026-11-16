import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import {
  classifySidecar,
  shouldRebuild,
  isAcceptableRebuild,
  nextAfterId,
  parseArgs,
  emptyCounts,
  formatCounts,
  DEFAULT_BEFORE,
} from './rebuild-old-sidecars.js';
import { buildSidecar } from '../services/mp4/sidecar.js';
import { buildSidecarForFile } from '../services/mp4/sidecarBuilder.js';
import type { RangeFetcher } from '../services/mp4/fragmentIndex.js';
import { makeFtyp, makeMoov, makeMoofMdat } from '../services/mp4/__test-fixtures.js';
import { story } from '../testing/story.js';

function prelude(withMehd: boolean): Buffer {
  return Buffer.concat([
    makeFtyp(),
    makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    }),
  ]);
}

const MFRA = Buffer.alloc(16, 1);
const PER_TRACK = [{ trackId: 1, timescale: 90000, perFragmentTicks: [9000, 9000] }];

describe('rebuild-old-sidecars [WORKER-086]', () => {
  it('[WORKER-086] sorts a sidecar whose moov has a mehd box as mehd', (ctx) => {
    story(ctx, 'An old-format sidecar with a mehd box is found, so the script can rebuild it.');
    expect(classifySidecar(buildSidecar(prelude(true), MFRA, 1000, PER_TRACK))).toBe('mehd');
    // The mehd check wins over the trailer version.
    expect(classifySidecar(buildSidecar(prelude(true), MFRA))).toBe('mehd');
  });

  it('[WORKER-086] sorts a sidecar without the per-track table as pre-v6', () => {
    expect(classifySidecar(buildSidecar(prelude(false), MFRA, 1000))).toBe('pre-v6');
    expect(classifySidecar(buildSidecar(prelude(false), MFRA))).toBe('pre-v6');
  });

  it('[WORKER-086] sorts a v6 sidecar without mehd as current', () => {
    expect(classifySidecar(buildSidecar(prelude(false), MFRA, 1000, PER_TRACK))).toBe('current');
  });

  it('[WORKER-086] sorts garbage as unreadable and never throws', () => {
    expect(classifySidecar(Buffer.alloc(3))).toBe('unreadable');
    expect(classifySidecar(Buffer.from('not a sidecar at all, just text'))).toBe('unreadable');
    // A valid envelope around a prelude that holds no moov.
    expect(classifySidecar(buildSidecar(Buffer.alloc(32), MFRA, 1000))).toBe('unreadable');
  });
});

describe('rebuild-old-sidecars [WORKER-087]', () => {
  it('[WORKER-087] rebuilds mehd always and pre-v6 only on request', () => {
    expect(shouldRebuild('mehd', false)).toBe(true);
    expect(shouldRebuild('pre-v6', false)).toBe(false);
    expect(shouldRebuild('pre-v6', true)).toBe(true);
    expect(shouldRebuild('current', true)).toBe(false);
    expect(shouldRebuild('unreadable', true)).toBe(false);
  });

  it('[WORKER-087] accepts a rebuilt sidecar only when it parses and has no mehd', () => {
    expect(isAcceptableRebuild(buildSidecar(prelude(false), MFRA, 1000, PER_TRACK))).toBe(true);
    expect(isAcceptableRebuild(buildSidecar(prelude(true), MFRA, 1000, PER_TRACK))).toBe(false);
    expect(isAcceptableRebuild(Buffer.alloc(3))).toBe(false);
  });

  it('[WORKER-087] the class A builder output on a mehd-free recording is acceptable', async () => {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000, 3000], mdatPayloadSize: 128 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 6000, sampleDurations: [3000, 3000], mdatPayloadSize: 128 });
    const file = Buffer.concat([ftyp, moov, frag1, frag2]);
    const fetcher: RangeFetcher = async (s, e) => file.slice(s, e + 1);
    const built = await buildSidecarForFile(file, file.length, fetcher);
    expect(built.classification.class).toBe('A');
    expect(isAcceptableRebuild(built.sidecar!)).toBe(true);
  });

  it('[WORKER-087] a recording that is not class A yields no sidecar to write', async () => {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 5000,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: true,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const file = Buffer.concat([ftyp, moov, makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000], mdatPayloadSize: 64 })]);
    const built = await buildSidecarForFile(file, file.length, async (s, e) => file.slice(s, e + 1));
    expect(built.classification.class).not.toBe('A');
    expect(built.sidecar).toBeNull();
  });
});

describe('rebuild-old-sidecars [WORKER-089]', () => {
  it('[WORKER-089] defaults to a real run from the start with no bounds', () => {
    const o = parseArgs([]);
    expect(o.dryRun).toBe(false);
    expect(o.includePreV6).toBe(false);
    expect(o.maxScan).toBe(Infinity);
    expect(o.maxRebuild).toBe(Infinity);
    expect(o.afterId).toBe(0);
    expect(o.before.toISOString().slice(0, 10)).toBe(DEFAULT_BEFORE);
  });

  it('[WORKER-089] reads every option', () => {
    const o = parseArgs(['--dry-run', '--include-pre-v6', '--max-scan', '500', '--max-rebuild', '20', '--after-id', '42', '--before', '2026-01-01']);
    expect(o).toMatchObject({ dryRun: true, includePreV6: true, maxScan: 500, maxRebuild: 20, afterId: 42 });
    expect(o.before.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('[WORKER-089] DRY_RUN=true behaves as --dry-run', () => {
    expect(parseArgs([], { DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  it('[WORKER-089] rejects an unknown flag, a bad number and a bad date so a typo never starts a run', () => {
    expect(() => parseArgs(['--dryrun'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--max-scan', 'abc'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['--after-id'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['--before', 'soon'])).toThrow(/date/);
  });

  it('[WORKER-089] the cursor advances to the last id and holds on an empty page', () => {
    expect(nextAfterId([{ id: 3 }, { id: 9 }], 0)).toBe(9);
    expect(nextAfterId([], 7)).toBe(7);
  });

  it('[WORKER-089] the report names every kind', () => {
    const c = emptyCounts();
    c.scanned = 5;
    c.mehd = 2;
    c.rebuilt = 2;
    expect(formatCounts(c, true)).toBe(
      '5 scanned, mehd=2, pre-v6=0, current=0, unreadable=0, no-sidecar=0, would-rebuild=2, rejected=0, failed=0',
    );
    expect(formatCounts(c, false)).toContain('rebuilt=2');
  });
});
