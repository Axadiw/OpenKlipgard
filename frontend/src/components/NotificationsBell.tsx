import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTranslation } from '../i18n';
import type { Notification, NotificationKind } from '../types';
import { track } from '../lib/analytics';

const POLL_INTERVAL_MS = 60_000;
const KIND_ICON: Record<NotificationKind, string> = {
  storage_quota_exceeded: '💾',
  transfer_quota_exceeded: '📡',
  invalid_file: '⚠️',
  thumbnail_failed: '🖼️',
  user_banned: '🚫',
  auto_deleted_oldest: '🧹',
  duplicate_file: '🗂️',
  plan_change_cancelled: '↩️',
  content_deletion_scheduled: '⏳',
  content_deleted: '🗑️',
};

// WEB-NOTIF-024: the `details.locKey` the server sends, the catalog key of the
// text, and the names of the positional `locArgs` that fill its placeholders.
const LOC_KEY_MESSAGES = new Map<string, { key: string; args?: string[] }>([
  ['notif.storage_quota_exceeded.body', { key: 'notifications.msg.storageQuota' }],
  ['notif.storage_quota_exceeded.near', { key: 'notifications.msg.storageQuotaNear' }],
  ['notif.storage_quota_exceeded.over', { key: 'notifications.msg.storageQuotaOver' }],
  ['notif.storage_quota_exceeded.headroom', { key: 'notifications.msg.storageQuotaHeadroom' }],
  ['notif.transfer_quota_exceeded.body', { key: 'notifications.msg.transferQuota' }],
  ['notif.transfer_quota_exceeded.upload', { key: 'notifications.msg.transferQuotaUpload' }],
  ['notif.transfer_quota_exceeded.download', { key: 'notifications.msg.transferQuotaDownload' }],
  ['notif.invalid_file.body', { key: 'notifications.msg.invalidFile' }],
  ['notif.invalid_file.too_large', { key: 'notifications.msg.invalidFileTooLarge' }],
  ['notif.invalid_file.viewCollapsed', { key: 'notifications.msg.invalidFileViewCollapsed', args: ['filename'] }],
  ['notif.duplicate_file.body', { key: 'notifications.msg.duplicateFile', args: ['camera'] }],
  ['notif.thumbnail_failed.body', { key: 'notifications.msg.thumbnailFailed', args: ['filename'] }],
]);

/** The text of a known `details.locKey`, or null: then the caller shows the stored message. */
function textForLocKey(
  details: Record<string, unknown> | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  const locKey = details?.locKey;
  const entry = typeof locKey === 'string' ? LOC_KEY_MESSAGES.get(locKey) : undefined;
  if (!entry) return null;
  const locArgs = Array.isArray(details?.locArgs) ? details.locArgs : [];
  const params: Record<string, string> = {};
  for (const [i, name] of (entry.args ?? []).entries()) {
    const value = locArgs[i];
    if (typeof value !== 'string') return null;
    params[name] = value;
  }
  return t(entry.key, params);
}

interface NotificationGroup {
  kind: NotificationKind;
  items: Notification[];
  latestAt: string;
  unreadCount: number;
}

function groupByKind(items: Notification[]): NotificationGroup[] {
  const byKind = new Map<NotificationKind, Notification[]>();
  for (const n of items) {
    const arr = byKind.get(n.kind) ?? [];
    arr.push(n);
    byKind.set(n.kind, arr);
  }
  const groups: NotificationGroup[] = [];
  for (const [kind, kindItems] of byKind) {
    kindItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    groups.push({
      kind,
      items: kindItems,
      latestAt: kindItems[0].createdAt,
      unreadCount: kindItems.filter(n => !n.readAt).length,
    });
  }
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return groups;
}

export function NotificationsBell() {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<NotificationKind>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(() => {
    api.getUnreadNotificationCount()
      .then(r => setCount(r.count))
      .catch(() => { /* silent */ });
  }, []);

  const loadList = useCallback(() => {
    setLoading(true);
    api.listNotifications({ limit: 50 })
      .then(r => setItems(r.notifications))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshCount();
    const id = window.setInterval(refreshCount, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    loadList();
    setExpandedKinds(new Set());
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, loadList]);

  const markOne = async (id: string) => {
    try {
      await api.markNotificationRead(id);
      setItems(prev => prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
      refreshCount();
    } catch { /* ignore */ }
  };

  const markAll = async () => {
    try {
      await api.markAllNotificationsRead();
      const now = new Date().toISOString();
      setItems(prev => prev.map(n => n.readAt ? n : { ...n, readAt: now }));
      setCount(0);
    } catch { /* ignore */ }
  };

  const deleteOne = async (id: string, wasUnread: boolean) => {
    try {
      await api.deleteNotification(id);
      setItems(prev => prev.filter(n => n.id !== id));
      if (wasUnread) refreshCount();
    } catch { /* ignore */ }
  };

  const deleteAllRead = async () => {
    try {
      await api.deleteReadNotifications();
      setItems(prev => prev.filter(n => !n.readAt));
    } catch { /* ignore */ }
  };

  const toggleGroup = (kind: NotificationKind) => {
    setExpandedKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const deleteGroup = async (group: NotificationGroup) => {
    const confirmed = window.confirm(t('notifications.confirmDeleteGroup', { count: group.items.length }));
    if (!confirmed) return;
    const ids = group.items.map(n => n.id);
    const hadUnread = group.unreadCount > 0;
    setItems(prev => prev.filter(n => n.kind !== group.kind));
    try {
      await Promise.all(ids.map(id => api.deleteNotification(id).catch(() => null)));
    } finally {
      if (hadUnread) refreshCount();
    }
  };

  // Notifications that reference a concrete event (thumbnail_failed,
  // invalid_file, auto_deleted_oldest) carry its id in `details.eventId`.
  // Clicking the row routes to the existing player deep-link so the user
  // can jump straight to the affected recording.
  const eventIdFromDetails = (n: Notification): string | null => {
    const raw = (n.details as { eventId?: unknown } | null)?.eventId;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const getFilenameFromDetails = (n: Notification): string | null => {
    const raw = (n.details as { filename?: unknown } | null)?.filename;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const getDisplayMessage = (n: Notification): React.ReactNode => {
    // Stored in English for push and older clients; shown here in the
    // interface language from the plan name.
    if (n.kind === 'plan_change_cancelled') {
      const plan = (n.details as { plan?: unknown } | null)?.plan;
      return typeof plan === 'string' && plan ? t('notifications.planChangeCancelled', { plan }) : n.message;
    }
    if (n.kind === 'content_deletion_scheduled') {
      const d = n.details as { at?: unknown; final?: unknown } | null;
      if (typeof d?.at !== 'string') return n.message;
      // The deletion happens on a UTC day: name it as a UTC date, in the browser
      // locale like every other date in the bell (WEB-NOTIF-016).
      const at = new Date(d.at);
      if (Number.isNaN(at.getTime())) return n.message;
      let date: string;
      try {
        date = at.toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
      } catch {
        return n.message;
      }
      return t(d.final === true ? 'notifications.contentDeletionTomorrow' : 'notifications.contentDeletionScheduled', { date });
    }
    if (n.kind === 'content_deleted') return t('notifications.contentDeleted');
    // The server stores English in `message`; a known `locKey` gives the interface language.
    const text = textForLocKey(n.details, t) ?? n.message;
    if (n.kind !== 'invalid_file') return text;
    const filename = getFilenameFromDetails(n);
    if (!filename) return text;
    return `${text.replace(/\.$/, '')} (${filename}).`;
  };

  const openEvent = async (n: Notification) => {
    const eventId = eventIdFromDetails(n);
    if (!eventId) return;
    track('notification_open', { kind: n.kind });
    if (!n.readAt) {
      await markOne(n.id);
    }
    setOpen(false);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('event', eventId);
      next.set('view', 'wide');
      return next;
    }, { preventScrollReset: true });
  };

  const groups = useMemo(() => groupByKind(items), [items]);

  const renderItem = (n: Notification, opts: { inGroup: boolean }) => {
    const linkedEvent = eventIdFromDetails(n);
    return (
      <div
        key={n.id}
        className={`notification-item${n.readAt ? ' notification-read' : ''}${linkedEvent ? ' notification-linked' : ''}${opts.inGroup ? ' notification-item-grouped' : ''}`}
        onClick={() => !n.readAt && markOne(n.id)}
      >
        <span className="notification-icon">{KIND_ICON[n.kind] ?? '🔔'}</span>
        <div className="notification-body">
          <div className="notification-message">{getDisplayMessage(n)}</div>
          <div className="notification-time">{new Date(n.createdAt).toLocaleString()}</div>
          {linkedEvent && (
            <button
              className="btn btn-sm notification-open"
              onClick={(e) => { e.stopPropagation(); openEvent(n); }}
            >
              {t('notifications.openEvent')}
            </button>
          )}
        </div>
        <button
          className="btn btn-sm notification-delete"
          aria-label={t('notifications.delete')}
          title={t('notifications.delete')}
          onClick={(e) => { e.stopPropagation(); deleteOne(n.id, !n.readAt); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div className="notifications-wrapper" ref={wrapperRef}>
      <button
        className="btn btn-sm notifications-bell"
        onClick={() => setOpen(!open)}
        aria-label={t('notifications.title')}
        title={t('notifications.title')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        {count > 0 && <span className="notifications-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="dropdown-menu notifications-dropdown" role="menu" aria-label={t('notifications.title')}>
          <div className="notifications-header">
            <strong>{t('notifications.title')}</strong>
            <span className="notifications-actions">
              {items.some(n => !n.readAt) && (
                <button className="btn btn-sm" onClick={markAll}>{t('notifications.markAllRead')}</button>
              )}
              {items.some(n => !!n.readAt) && (
                <button className="btn btn-sm" onClick={deleteAllRead}>{t('notifications.deleteAllRead')}</button>
              )}
            </span>
          </div>
          {loading && <div className="dropdown-info">{t('events.loading')}</div>}
          {!loading && items.length === 0 && (
            <div className="dropdown-info">{t('notifications.empty')}</div>
          )}
          {!loading && groups.map(group => {
            if (group.items.length === 1) {
              return renderItem(group.items[0], { inGroup: false });
            }
            const expanded = expandedKinds.has(group.kind);
            const kindLabel = t(`notifications.kind.${group.kind}`);
            const newestLabel = t('notifications.newestAt', {
              time: new Date(group.latestAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
            return (
              <div key={group.kind} className={`notification-group${expanded ? ' notification-group-expanded' : ''}`}>
                <div
                  className={`notification-group-header${group.unreadCount > 0 ? '' : ' notification-group-allread'}`}
                  onClick={() => toggleGroup(group.kind)}
                  role="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? t('notifications.collapseGroup') : t('notifications.expandGroup')}
                >
                  <span className="notification-icon">{KIND_ICON[group.kind] ?? '🔔'}</span>
                  <div className="notification-body">
                    <div className="notification-group-title">
                      <span className="notification-group-label">{kindLabel}</span>
                      <span className="notification-group-count">{group.items.length}</span>
                      {group.unreadCount > 0 && group.unreadCount < group.items.length && (
                        <span className="notification-group-unread" title={String(group.unreadCount)}>
                          {group.unreadCount}
                        </span>
                      )}
                    </div>
                    <div className="notification-time">{newestLabel}</div>
                  </div>
                  <span className={`notification-group-chevron${expanded ? ' notification-group-chevron-open' : ''}`} aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18"/>
                    </svg>
                  </span>
                  <button
                    className="btn btn-sm notification-delete"
                    aria-label={t('notifications.deleteAllOfKind')}
                    title={t('notifications.deleteAllOfKind')}
                    onClick={(e) => { e.stopPropagation(); deleteGroup(group); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                </div>
                {expanded && (
                  <div className="notification-group-children">
                    {group.items.map(n => renderItem(n, { inGroup: true }))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
