import { describe, it, expect } from 'vitest';
import { STARTER_PATTERN, namedGroups, parseMatch, runJob, tokenize, validatePattern } from './cameraPattern';

const REOLINK = '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
const job = (source: string, name: string) => runJob({ key: 'k', source, name });

describe('tokenize', () => {
  it('round-trips the source and tags named groups', () => {
    const toks = tokenize(REOLINK);
    expect(toks.map(t => t.text).join('')).toBe(REOLINK);
    expect(toks.find(t => t.text === '(?<camera>')?.cls).toBe('open camera');
    expect(toks.find(t => t.text === '(?<view>')?.cls).toBe('open view');
  });
  it('colours the lens group like view', () => {
    expect(tokenize('(?<lens>0)')[0].cls).toBe('open view');
  });
  it('ignores escaped parentheses and class contents', () => {
    expect(namedGroups('\\(?<camera>x[(?<ts>]')).toEqual([]);
  });
});

describe('validatePattern', () => {
  it('accepts the starter pattern', () => {
    expect(validatePattern(STARTER_PATTERN).error).toBeNull();
  });
  it('reports empty, syntax, length and missing groups', () => {
    expect(validatePattern('  ').error?.kind).toBe('empty');
    expect(validatePattern('(').error?.kind).toBe('syntax');
    expect(validatePattern('a'.repeat(501)).error?.kind).toBe('tooLong');
    const r = validatePattern('^(?<camera>.+)$');
    expect(r.error?.kind).toBe('groups');
    expect(r.missing).toEqual(['ts', 'ext']);
  });
});

describe('runJob', () => {
  it('matches case-insensitively and returns group spans', () => {
    const r = job(REOLINK, 'FRONT_00_20240115143022.MP4');
    expect(r.status).toBe('match');
    if (r.status !== 'match') return;
    const m = parseMatch('FRONT_00_20240115143022.MP4', r);
    expect(m).toMatchObject({ camera: 'FRONT', view: '00', ts: '20240115143022', ext: 'MP4' });
    expect(m.segs.filter(s => s.group).map(s => s.group)).toEqual(['camera', 'view', 'ts', 'ext']);
  });
  it('strips non-digits from ts and requires 14 digits', () => {
    const axis = '^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.(?<ext>mp4)$';
    expect(job(axis, 'Parking_2024-01-15_14-30-22.mp4').status).toBe('match');
    const short = '^(?<camera>.+)_(?<ts>\\d{12})\\.(?<ext>mp4)$';
    expect(job(short, 'A_202401151430.mp4')).toMatchObject({ status: 'nomatch', reason: 'tsDigits' });
  });
  it('falls back from view to lens', () => {
    const r = job('^(?<camera>\\w+)_(?<lens>\\d\\d)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'A_01_20240115143022.mp4');
    expect(r.status === 'match' && parseMatch('x', r).view).toBe('01');
  });
  it('explains why a name does not match', () => {
    expect(job(REOLINK, 'x'.repeat(1025))).toMatchObject({ reason: 'tooLong' });
    expect(job('^(?<camera>A)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'A_20240115143022.mp4x')).toMatchObject({ reason: 'partial' });
    expect(job(REOLINK, 'Front_00_2024.mp4')).toMatchObject({ reason: 'fewDigits' });
    expect(job(REOLINK, 'Front_00_20240115143022.avi')).toMatchObject({ reason: 'extension' });
    expect(job(REOLINK, 'Webcam_G12345_20240115143022.mp4')).toMatchObject({ reason: 'generic' });
  });
});
