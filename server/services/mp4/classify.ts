import { Buffer } from 'buffer';
import { readBoxHeader, walkTopBoxes } from './boxes.js';
import { inspectMoov } from './moov.js';

export type Mp4Class =
  /**
   * Reolink-style fragmented MP4 missing mehd + mfra. Generate sidecar.
   * Why the sidecar exists: without it every player has to scan all
   * fragments before `loadedmetadata`; on Slow 4G that is a multi-minute
   * spinner.
   */
  | 'A'
  /** Already-good MP4: moov has mehd, or it's a non-fragmented mp4 with
   *  moov at front. Skip sidecar. There is no tail probe for a trailing
   *  `mfra` — a fragmented file without `mehd` is class A regardless. */
  | 'B'
  /** Non-fragmented MP4 with moov-at-end. Skip sidecar (browser tail-fetch). */
  | 'C'
  /** Unsupported container (not mp4: mkv/webm/avi/etc). Reject. */
  | 'D'
  /** MP4 we couldn't parse — malformed or truncated. Reject. */
  | 'E';

export interface ClassificationResult {
  class: Mp4Class;
  reason?: string;
}

/**
 * Classify the file based on its head buffer (and optionally a tail probe).
 * Returns the class plus a short reason. Caller decides what to do next.
 *
 * Classes:
 *   A — fragmented mp4 missing mehd; we generate sidecar
 *   B — already good (mehd present, OR non-fragmented with moov at front;
 *       there is no tail probe, so a trailing mfra is never checked)
 *   C — non-fragmented with moov-at-end
 *   D — not an mp4 (rejected)
 *   E — malformed mp4 (rejected)
 */
export function classifyHead(headBuf: Buffer): ClassificationResult {
  if (headBuf.length < 8) return { class: 'E', reason: 'buffer too short' };

  // Check ftyp at offset 0
  const ftyp = readBoxHeader(headBuf, 0);
  if (!ftyp) return { class: 'E', reason: 'unreadable first box' };
  if (ftyp.type !== 'ftyp') {
    return { class: 'D', reason: `first box is "${ftyp.type}", not ftyp` };
  }

  // Walk top-level boxes within head buffer
  const boxes = walkTopBoxes(headBuf);
  const types = boxes.map((b) => b.header.type);

  // Find moov; if not in head OR not directly after ftyp, treat as
  // moov-at-end (class C). Reolink puts moov right after ftyp; standard
  // ffmpeg-without-faststart puts it after mdat. Both are valid; only the
  // first is patchable, the second is left to the browser's tail-fetch.
  const moovIdx = types.indexOf('moov');
  if (moovIdx === -1 || moovIdx !== 1) {
    return { class: 'C', reason: 'moov not at position 1 (likely moov-at-end)' };
  }

  // Check if file has moof boxes — fragmented vs non-fragmented
  const hasMoof = types.includes('moof');

  // Inspect moov for mehd
  let inspect;
  try {
    inspect = inspectMoov(headBuf);
  } catch (err) {
    return {
      class: 'E',
      reason: `moov parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (inspect.moov.hasMehd) {
    return { class: 'B', reason: 'moov.mvex.mehd already present' };
  }

  if (hasMoof || inspect.moov.hasMvex) {
    // Fragmented mp4 missing mehd — our default Reolink case.
    return { class: 'A', reason: 'fragmented mp4 missing mehd' };
  }

  // Non-fragmented mp4 with moov at front; fine for browser playback.
  return { class: 'B', reason: 'non-fragmented mp4 with moov at front' };
}
