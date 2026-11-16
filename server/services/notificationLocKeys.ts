// API-EVENTS-295: the variant `locKey` of a notification that the FTPS server
// posts to POST /internal/notifications. The FTPS server sends English text and
// plain details. This maps the kind and the details to a catalog key, so the
// apps and the web app can show the text in the language of the user.
import type { NotificationKind } from '../types.js';

function variantKey(kind: NotificationKind, d: Record<string, unknown>): string | undefined {
  switch (kind) {
    case 'storage_quota_exceeded':
      return d.reason === 'exceeds_remaining_headroom'
        ? 'notif.storage_quota_exceeded.headroom'
        : 'notif.storage_quota_exceeded.body';
    case 'transfer_quota_exceeded':
      if (d.direction === 'download') return 'notif.transfer_quota_exceeded.download';
      if (d.direction === 'upload') return 'notif.transfer_quota_exceeded.upload';
      return 'notif.transfer_quota_exceeded.body';
    case 'invalid_file':
      if (d.reason === 'magic_bytes') return 'notif.invalid_file.body';
      return d.direction === 'upload' ? 'notif.invalid_file.too_large' : 'notif.invalid_file.body';
    default:
      return undefined;
  }
}

/**
 * The `details` with a variant `locKey` and an empty `locArgs`. Returns the
 * input untouched for a kind without variants, or when the caller already set
 * a string `locKey`.
 */
export function withVariantLocKey(
  kind: NotificationKind,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (typeof details?.locKey === 'string') return details;
  const locKey = variantKey(kind, details ?? {});
  return locKey ? { ...details, locKey, locArgs: [] } : details;
}
