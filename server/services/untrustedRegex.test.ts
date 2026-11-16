import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  safeRegexExec,
  assertUntrustedRegexSafe,
  RegexTimeoutError,
  MAX_UNTRUSTED_INPUT,
  _shutdownRegexWorker,
  missingRequiredGroups,
} from './untrustedRegex.js';

// The default budget is 500 ms. On a CI runner shared with other jobs even spawning the worker for a
// SAFE pattern can exceed that, so the "returns named groups" / "passes a normal regex" tests fail
// with a timeout that has nothing to do with the code. 4 s still kills the catastrophic patterns
// below (they never finish) and fits their 10 s test limit.
vi.hoisted(() => { process.env.UNTRUSTED_REGEX_TIMEOUT_MS = '4000'; });

afterAll(async () => {
  await _shutdownRegexWorker();
});

describe('missingRequiredGroups', () => {
  it('WEB-SET-CAMERAS-034: names the required groups a pattern does not declare', () => {
    expect(missingRequiredGroups('^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$')).toEqual([]);
    expect(missingRequiredGroups('^(?<ts>\\d{14})\\.(?<ext>mp4)$')).toEqual(['camera']);
    expect(missingRequiredGroups('^(.+)$')).toEqual(['camera', 'ts', 'ext']);
  });

  it('WEB-SET-CAMERAS-034: an escaped parenthesis or a character class does not declare a group', () => {
    expect(missingRequiredGroups('^\\(?<camera>x)_(?<ts>1)(?<ext>y)$')).toEqual(['camera']);
    expect(missingRequiredGroups('^[(?<camera>]_(?<ts>1)(?<ext>y)$')).toEqual(['camera']);
  });

  it('WEB-SET-CAMERAS-034: the optional view group does not replace a required one', () => {
    expect(missingRequiredGroups('^(?<view>00)_(?<ts>1)(?<ext>y)$')).toEqual(['camera']);
  });
});

describe('safeRegexExec', () => {
  it('returns named groups for a safe matching regex', async () => {
    const r = await safeRegexExec('^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'i', 'Front_20260101120000.mp4');
    expect(r.matched).toBe(true);
    expect(r.groups).toMatchObject({ camera: 'Front', ts: '20260101120000', ext: 'mp4' });
  });

  it('returns matched=false for a safe non-matching regex', async () => {
    const r = await safeRegexExec('^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'i', 'not-a-camera-file.txt');
    expect(r.matched).toBe(false);
    expect(r.groups).toBeNull();
  });

  it('rejects with RegexTimeoutError on catastrophic backtracking', async () => {
    // (a+)+$ on a long run of "a" with a non-matching tail is the textbook
    // exponential-backtracking ReDoS; must be killed by the timeout.
    await expect(
      safeRegexExec('^(a+)+$', '', 'a'.repeat(60) + '!'),
    ).rejects.toBeInstanceOf(RegexTimeoutError);
  }, 10_000);

  it('short-circuits over-long input to no-match (length cap)', async () => {
    const r = await safeRegexExec('^.+$', '', 'x'.repeat(MAX_UNTRUSTED_INPUT + 1));
    expect(r.matched).toBe(false);
  });
});

describe('assertUntrustedRegexSafe', () => {
  it('passes a normal camera-profile regex', async () => {
    const reason = await assertUntrustedRegexSafe(
      '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4|jpg)$',
      'i',
    );
    expect(reason).toBeNull();
  });

  it('rejects a catastrophic profile-shaped regex', async () => {
    const reason = await assertUntrustedRegexSafe(
      '^(?<camera>([a-z]+)+)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
      'i',
    );
    expect(reason).toMatch(/catastrophic|too slow/i);
  }, 10_000);

  it('rejects an invalid regex with a reason', async () => {
    const reason = await assertUntrustedRegexSafe('(unclosed', 'i');
    expect(reason).toMatch(/invalid regex/i);
  });
});
