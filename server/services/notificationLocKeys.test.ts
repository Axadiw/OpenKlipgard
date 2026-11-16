import { describe, it, expect } from 'vitest';
import { withVariantLocKey } from './notificationLocKeys.js';

describe('withVariantLocKey [API-EVENTS-295]', () => {
  it.each([
    ['storage_quota_exceeded', { path: '/a.mp4', attemptedBytes: 5 }, 'notif.storage_quota_exceeded.body'],
    ['storage_quota_exceeded', { path: '/a.mp4', direction: 'upload' }, 'notif.storage_quota_exceeded.body'],
    ['storage_quota_exceeded', { reason: 'exceeds_remaining_headroom', remainingBytes: 9 }, 'notif.storage_quota_exceeded.headroom'],
    ['transfer_quota_exceeded', { direction: 'download' }, 'notif.transfer_quota_exceeded.download'],
    ['transfer_quota_exceeded', { direction: 'upload' }, 'notif.transfer_quota_exceeded.upload'],
    ['transfer_quota_exceeded', {}, 'notif.transfer_quota_exceeded.body'],
    ['invalid_file', { filename: 'x.mp4', reason: 'magic_bytes' }, 'notif.invalid_file.body'],
    ['invalid_file', { path: '/x.mp4', direction: 'upload' }, 'notif.invalid_file.too_large'],
    ['invalid_file', { filename: 'x.mp4' }, 'notif.invalid_file.body'],
  ] as const)('%s %j gets %s and an empty locArgs', (kind, details, locKey) => {
    expect(withVariantLocKey(kind, { ...details })).toEqual({ ...details, locKey, locArgs: [] });
  });

  it('works when the FTPS server sends no details', () => {
    expect(withVariantLocKey('transfer_quota_exceeded', undefined)).toEqual({
      locKey: 'notif.transfer_quota_exceeded.body', locArgs: [],
    });
  });

  it('adds nothing to user_banned', () => {
    const details = { reason: 'x' };
    expect(withVariantLocKey('user_banned', details)).toBe(details);
    expect(withVariantLocKey('user_banned', undefined)).toBeUndefined();
  });

  it('keeps a locKey that the caller already set', () => {
    const details = { locKey: 'notif.invalid_file.viewCollapsed', locArgs: ['a.mp4'], direction: 'upload' };
    expect(withVariantLocKey('invalid_file', details)).toBe(details);
  });
});
