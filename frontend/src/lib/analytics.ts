// frontend/src/lib/analytics.ts
//
// Usage-analytics facade for the shared core, shaped like errorReporting.ts:
// the core says what happened through `track()`, an edition decides where it
// goes by installing a sink from its `init()`. Without a sink every call is
// dropped, so the shared tree pulls in no analytics SDK and sends nothing.
//
// The catalog of names and parameters is docs/analytics-events.md. Every
// parameter is a bounded fixed value: never an e-mail, a camera name, a
// recording id, a host or a free-text message.

import { ApiError } from '../api';
import type { NotificationKind } from '../types';

export type LoginMethod = 'password' | 'passkey' | 'google' | 'apple' | 'backup_code';
export type VideoView = 'wide' | 'zoom' | 'other';
export type VideoSurface = 'grid' | 'timeline';
export type FilterKind = 'cameras' | 'date' | 'time' | 'range' | 'mode' | 'clear';
export type CoreSetting =
  | 'language' | 'theme' | 'auto_delete_oldest' | 'auto_delete_days' | 'notifications'
  | 'camera_profile' | 'mcp_client_revoke';

/** The events the shared core sends (docs/analytics-events.md). */
export interface CoreAnalyticsEvents {
  login: { method: LoginMethod };
  login_error: { code: string };
  logout: { scope: 'device' | 'all' };
  video_play: { surface: VideoSurface; view: VideoView };
  video_complete: { surface: VideoSurface; view: VideoView };
  video_download: { view: VideoView };
  video_stall_retry: { attempt: number };
  video_stall_gave_up: { attempts: number };
  view_mode_switch: { to: 'grid' | 'timeline' };
  filter_apply: { filter: FilterKind; cameras_count: number };
  notification_open: { kind: NotificationKind };
  bulk_delete: { count: '1' | '2-10' | '11-50' | '51+' };
  event_delete: Record<string, never>;
  settings_change: { setting: CoreSetting };
  quota_warning_view: { level: 80 | 100 };
}

export type AnalyticsSink = (name: string, params: Record<string, unknown>) => void;

let sink: AnalyticsSink | null = null;

/** Route the core's events to `s`; `undefined` drops them again. */
export function installAnalyticsSink(s: AnalyticsSink | undefined): void {
  sink = s ?? null;
}

export function track<K extends keyof CoreAnalyticsEvents>(name: K, params: CoreAnalyticsEvents[K]): void {
  if (!sink) return;
  try {
    sink(name, params as Record<string, unknown>);
  } catch {
    // Analytics must never break the app.
  }
}

/** A bounded error code for `*_error` events: the API's `code` when it looks
 *  like one (UPPER_SNAKE), else a class of the failure. Never the message. */
export function analyticsErrorCode(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.body?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
    if (err.status === 401) return 'invalid_credentials';
    if (err.status === 429) return 'rate_limited';
    if (err.status === 423) return 'locked';
    if (err.status === 403) return 'forbidden';
    if (err.status >= 500) return 'server_error';
    return `http_${err.status}`;
  }
  // A WebAuthn ceremony the user dismissed (or that timed out) is NotAllowedError.
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'NotAllowedError' ? 'passkey_cancelled' : 'passkey_failed';
  }
  if (err instanceof TypeError) return 'network';
  return 'unknown';
}

/** Bucket a count so a parameter stays a small fixed set. */
export function countBucket(n: number): '1' | '2-10' | '11-50' | '51+' {
  if (n <= 1) return '1';
  if (n <= 10) return '2-10';
  if (n <= 50) return '11-50';
  return '51+';
}

/** The recording view as the catalog names it. Reolink's `00` is the wide
 *  lens and `01` the zoom; a custom camera profile's own view ids are free
 *  text, so they all report as `other`. */
export function analyticsView(view: string): VideoView {
  if (view === '00' || view === 'wide') return 'wide';
  if (view === '01' || view === 'zoom') return 'zoom';
  return 'other';
}
