#!/usr/bin/env node
/**
 * Operator-run script: rebuild old-format `.fmp4patch` sidecars ([WORKER-085]
 * to [WORKER-089]).
 *
 * Why: a sidecar from before 2026-05-10 carries a 16-byte `mehd` box in its
 * patched moov. The video route cannot use it (it would misalign the mdat zone
 * by 16 bytes), so it falls back to raw pass-through on EVERY request, which is
 * a slow playback start. A rebuilt sidecar takes the stitched path. Sidecars
 * without the v6 per-track table need no rebuild for playback today: the API
 * ignores the table. They are counted, and rebuilt only on request.
 *
 * Usage (inside the API container, which has the required env vars):
 *
 *   node dist/scripts/rebuild-old-sidecars.js --dry-run
 *   node dist/scripts/rebuild-old-sidecars.js
 *
 * Options:
 *   --dry-run            read the sidecars, report counts, write nothing
 *   --before <date>      only recordings uploaded before this date (default 2026-05-16)
 *   --include-pre-v6     also rebuild sidecars that have no per-track table
 *   --max-scan <n>       stop after n recordings scanned (each costs one small GET)
 *   --max-rebuild <n>    stop after n sidecars rebuilt
 *   --after-id <n>       resume after this file_metadata id (printed by every progress line)
 *
 * Object store cost (Backblaze B2, bill per transaction):
 *   - scan:    one GET of a ~5 KB sidecar per recording. A recording with no
 *              sidecar (class B/C) costs one 404.
 *   - rebuild: one HEAD, one 4 MiB head read, the moof range reads, one PUT.
 *   Nothing is listed. Nothing is deleted.
 *
 * Idempotent / resumable / safe to kill at any point: a PUT replaces one small
 * object, a rebuilt sidecar classifies as `current` on the next run, and the
 * script writes nothing to the database. It calls `buildSidecarForFile`
 * directly, NOT `generateSidecarForFile`, which would skip `ready` rows and
 * charge `processing_attempts`. An S3 error skips the row; nothing is ever
 * tombstoned.
 *
 * Not wired into any reconcile pass or cron. A CronJob is warranted only if the
 * sidecar format keeps changing; it would then be a job of its own, never a
 * pass of `klipgard-audit`.
 *
 * Recordings that also lack `.clean_frame` / `.frames` are the business of
 * `backfill-frame-grids`, not of this script.
 */

import type { Readable } from 'stream';
import { Buffer } from 'buffer';
import { initDb } from '../db/index.js';
import { getReadyFilesBeforeAfterId, type SidecarScanRow } from '../db/queries/events.js';
import { getObject, headObject, putObject } from '../services/s3.js';
import { buildSidecarForFile } from '../services/mp4/sidecarBuilder.js';
import { parseSidecar } from '../services/mp4/sidecar.js';
import { inspectMoov } from '../services/mp4/moov.js';
import type { RangeFetcher } from '../services/mp4/fragmentIndex.js';
import { isS3NotFound } from '../services/cleanFrameLoad.js';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch size per DB page. */
export const BATCH_SIZE = 200;

/** Head-window size, the same 4 MiB as fmp4PatchWorker. */
const HEAD_BYTES = 4 * 1024 * 1024;

/** A sidecar is ~5 KB. Anything near this is corrupt. */
const MAX_SIDECAR_BYTES = 1024 * 1024;

/** Uploads from before this date are the only candidates ([WORKER-086]). */
export const DEFAULT_BEFORE = '2026-05-16';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type SidecarKind = 'mehd' | 'pre-v6' | 'current' | 'unreadable';

/**
 * Sort one sidecar into a kind ([WORKER-086]). Never throws: a sidecar that does
 * not parse, or whose prelude has no readable moov, is `unreadable`.
 */
export function classifySidecar(buf: Buffer): SidecarKind {
  try {
    const { prelude, perTrack } = parseSidecar(buf);
    if (inspectMoov(prelude).moov.hasMehd) return 'mehd';
    return perTrack && perTrack.length > 0 ? 'current' : 'pre-v6';
  } catch {
    return 'unreadable';
  }
}

/** [WORKER-087]: `mehd` always, `pre-v6` only on request. */
export function shouldRebuild(kind: SidecarKind, includePreV6: boolean): boolean {
  return kind === 'mehd' || (kind === 'pre-v6' && includePreV6);
}

/**
 * [WORKER-087]: a rebuilt sidecar is written only if it parses and its moov has
 * no `mehd` box. A recording whose original moov has a `mehd` box would
 * otherwise be rewritten forever.
 */
export function isAcceptableRebuild(buf: Buffer): boolean {
  const kind = classifySidecar(buf);
  return kind === 'current' || kind === 'pre-v6';
}

export function nextAfterId(rows: { id: number }[], current: number): number {
  return rows.length === 0 ? current : rows[rows.length - 1].id;
}

export interface Options {
  dryRun: boolean;
  before: Date;
  includePreV6: boolean;
  maxScan: number;
  maxRebuild: number;
  afterId: number;
}

/** Parse argv. Throws on an unknown flag or a bad value so a typo never starts a run. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): Options {
  const opts: Options = {
    dryRun: env.DRY_RUN === 'true',
    before: new Date(`${DEFAULT_BEFORE}T00:00:00Z`),
    includePreV6: false,
    maxScan: Infinity,
    maxRebuild: Infinity,
    afterId: 0,
  };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a non-negative integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--include-pre-v6': opts.includePreV6 = true; break;
      case '--max-scan': opts.maxScan = num(a, argv[++i]); break;
      case '--max-rebuild': opts.maxRebuild = num(a, argv[++i]); break;
      case '--after-id': opts.afterId = num(a, argv[++i]); break;
      case '--before': {
        const d = new Date(argv[++i] ?? '');
        if (Number.isNaN(d.getTime())) throw new Error('--before needs a date such as 2026-05-16');
        opts.before = d;
        break;
      }
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return opts;
}

export interface Counts {
  scanned: number;
  mehd: number;
  preV6: number;
  current: number;
  unreadable: number;
  missing: number;
  rebuilt: number;
  rejected: number;
  failed: number;
}

export function emptyCounts(): Counts {
  return { scanned: 0, mehd: 0, preV6: 0, current: 0, unreadable: 0, missing: 0, rebuilt: 0, rejected: 0, failed: 0 };
}

export function formatCounts(c: Counts, dryRun: boolean): string {
  return (
    `${c.scanned} scanned, mehd=${c.mehd}, pre-v6=${c.preV6}, current=${c.current}, ` +
    `unreadable=${c.unreadable}, no-sidecar=${c.missing}, ` +
    `${dryRun ? 'would-rebuild' : 'rebuilt'}=${c.rebuilt}, rejected=${c.rejected}, failed=${c.failed}`
  );
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += b.length;
    if (total > maxBytes) throw new Error(`stream exceeded maxBytes=${maxBytes}`);
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

/** Existing sidecar bytes, or null when the object does not exist. Other errors throw. */
async function readSidecar(row: SidecarScanRow): Promise<Buffer | null> {
  try {
    const { body } = await getObject(CONFIG.s3SidecarsBucket, `${row.s3Key}.fmp4patch`, row.encryptionSalt ?? '');
    return await streamToBuffer(body as Readable, MAX_SIDECAR_BYTES);
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
}

/** Build the replacement sidecar from the original recording. Null for any class but A. */
async function buildReplacement(row: SidecarScanRow): Promise<Buffer | null> {
  const salt = row.encryptionSalt ?? '';
  const bucket = row.s3Bucket || CONFIG.s3RecordingsBucket;
  const { contentLength: fileSize } = await headObject(bucket, row.s3Key, salt);
  const headEnd = Math.min(HEAD_BYTES, fileSize) - 1;
  if (headEnd < 0) throw new Error('recording has zero size');
  const { body } = await getObject(bucket, row.s3Key, salt, `bytes=0-${headEnd}`);
  const headBuf = await streamToBuffer(body as Readable, HEAD_BYTES + 1024);
  const fetchRange: RangeFetcher = async (start, end) => {
    const r = await getObject(bucket, row.s3Key, salt, `bytes=${start}-${end}`);
    return streamToBuffer(r.body as Readable, end - start + 1 + 1024);
  };
  const result = await buildSidecarForFile(headBuf, fileSize, fetchRange);
  return result.classification.class === 'A' ? result.sidecar : null;
}

// ---------------------------------------------------------------------------
// Per-row processor
// ---------------------------------------------------------------------------

async function processRow(row: SidecarScanRow, opts: Options, counts: Counts): Promise<void> {
  const existing = await readSidecar(row);
  if (existing === null) {
    counts.missing++;
    return;
  }
  const kind = classifySidecar(existing);
  if (kind === 'mehd') counts.mehd++;
  else if (kind === 'pre-v6') counts.preV6++;
  else if (kind === 'current') counts.current++;
  else counts.unreadable++;

  if (!shouldRebuild(kind, opts.includePreV6)) return;
  if (opts.dryRun) {
    counts.rebuilt++;
    return;
  }

  const replacement = await buildReplacement(row);
  if (!replacement || !isAcceptableRebuild(replacement)) {
    counts.rejected++;
    console.warn(`[rebuild-old-sidecars] rejected rebuild of file_metadata ${row.id}: not class A or still has mehd`);
    return;
  }
  await putObject(CONFIG.s3SidecarsBucket, `${row.s3Key}.fmp4patch`, replacement, row.encryptionSalt ?? '', replacement.length);
  counts.rebuilt++;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** The scan loop. Exported for tests; `main` adds the database and the exit code. */
export async function runRebuild(opts: Options): Promise<Counts> {
  const counts = emptyCounts();
  let afterId = opts.afterId;
  console.log(
    `[rebuild-old-sidecars] starting: uploaded before ${opts.before.toISOString()}, after id ${afterId}` +
    `${opts.includePreV6 ? ', including pre-v6' : ''}`,
  );

  scan: for (;;) {
    const rows = await getReadyFilesBeforeAfterId(afterId, opts.before, BATCH_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (counts.scanned >= opts.maxScan || counts.rebuilt >= opts.maxRebuild) break scan;
      counts.scanned++;
      try {
        await processRow(row, opts, counts);
      } catch (err) {
        // S3 or parse error: skip the row. Never tombstone ([WORKER-088]).
        counts.failed++;
        console.error(`[rebuild-old-sidecars] FAILED file_metadata ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      afterId = row.id;
    }
    console.log(`[rebuild-old-sidecars] progress: ${formatCounts(counts, opts.dryRun)}, last id ${afterId}`);
  }

  console.log(`[rebuild-old-sidecars] done: ${formatCounts(counts, opts.dryRun)}, last id ${afterId}`);
  return counts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (opts.dryRun) console.log('[rebuild-old-sidecars] DRY RUN: no S3 writes will be performed');
  await initDb();
  const counts = await runRebuild(opts);
  if (counts.failed > 0) process.exit(1);
}

// Run only as a script: the unit tests import the pure helpers above.
if (process.argv[1] && /rebuild-old-sidecars\.(js|ts)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stdout.write(`[rebuild-old-sidecars] FATAL: ${msg}\n`);
      process.exit(1);
    },
  );
}
