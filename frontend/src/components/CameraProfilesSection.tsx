import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CameraProfileMode, UserCameraProfile, VendorProfileTemplate } from '../api';
import { ViewIcon } from './ViewIcon';
import { useTranslation } from '../i18n';
import { track } from '../lib/analytics';
import { MAX_PROFILES } from '../lib/cameraPattern';
import { ProfileEditor } from './cameraProfiles/ProfileEditor';
import type { OtherProfile } from './cameraProfiles/ProfileEditor';
import {
  NEW_KEY, byPriority, changedFields, draftFromProfile, isDirty, newDraft, sanitizeViews, viewIdsInOrder,
} from './cameraProfiles/draft';
import type { Draft } from './cameraProfiles/draft';
import './cameraProfiles/cameraProfiles.css';
import { KlipgardLoader } from './KlipgardLoader';

/**
 * Shared dark-mode styling for the native mode <select>. A bare <select>
 * renders with a white background in dark mode on most browsers; this matches
 * the sibling inputs.
 */
const SELECT_STYLE: React.CSSProperties = {
  background: 'var(--bg3)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '6px 10px',
};

// Recognition mode is binary in the UI: `auto` (try every built-in vendor
// pattern, a superset of the retired single-vendor modes) vs `custom`
// (user-authored profiles, seeded from vendor templates). The server enum
// still accepts the legacy single-vendor values (WEB-SET-CAMERAS-012).
type UiMode = 'auto' | 'custom';
const MODE_OPTIONS: { value: UiMode; labelKey: string; descKey: string }[] = [
  { value: 'auto', labelKey: 'settings.cameraProfiles.modeAuto', descKey: 'settings.cameraProfiles.descAuto' },
  { value: 'custom', labelKey: 'settings.cameraProfiles.modeCustom', descKey: 'settings.cameraProfiles.descCustom' },
];

/** A legacy single-vendor value DISPLAYS as `auto` and is not auto-persisted. */
function toUiMode(mode: CameraProfileMode | null): UiMode | null {
  if (mode === null) return null;
  return mode === 'custom' ? 'custom' : 'auto';
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface RowProps {
  name: string;
  priority: number;
  enabled: boolean;
  views: UserCameraProfile['viewsConfig'];
  selected: boolean;
  unsaved: boolean;
  toggleId?: number;
  toggling: boolean;
  onSelect: () => void;
  onToggle?: () => void;
}

function ProfileRow({ name, priority, enabled, views, selected, unsaved, toggleId, toggling, onSelect, onToggle }: RowProps) {
  const { t } = useTranslation();
  return (
    <li className={`cp-prow${selected ? ' is-sel' : ''}${enabled ? '' : ' is-off'}`}>
      <button type="button" className="cp-pmain" onClick={onSelect} aria-pressed={selected} data-testid={toggleId ? `profile-row-${toggleId}` : 'profile-row-new'}>
        <span className="cp-pname">{name}</span>
        <span className="cp-pmeta">
          <span className="cp-prio-badge" title={t('settings.cameraProfiles.profilePriority')}>{Number.isNaN(priority) ? '–' : priority}</span>
          {views.slice(0, 3).map((v, k) => (
            <span key={k} className="cp-mini" title={`${v.id}: ${t(`profile.viewIcon.${v.iconKind}`)}`}>
              <ViewIcon kind={v.iconKind} size={13} />
            </span>
          ))}
          {unsaved && (
            <span className="cp-unsaved" title={t('settings.cameraProfiles.pg.unsaved')} data-testid="profile-unsaved">
              <span aria-hidden="true">●</span>
              <span className="cp-sr">{t('settings.cameraProfiles.pg.unsaved')}</span>
            </span>
          )}
        </span>
      </button>
      {onToggle && (
        <label className="settings-toggle cp-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={onToggle}
            disabled={toggling}
            aria-label={name}
            data-testid={`profile-toggle-${toggleId}`}
          />
          <span />
        </label>
      )}
    </li>
  );
}

export function CameraProfilesSection() {
  const { t } = useTranslation();
  // `mode` holds the raw server value (may be a legacy single-vendor string);
  // `toUiMode(mode)` collapses it for display and branching.
  const [mode, setMode] = useState<CameraProfileMode | null>(null);
  const [profiles, setProfiles] = useState<UserCameraProfile[]>([]);
  const [templates, setTemplates] = useState<VendorProfileTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modeChanging, setModeChanging] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [ownNames, setOwnNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState('');

  useEffect(() => {
    api.getCameraProfiles()
      .then(r => {
        setMode(r.mode);
        setProfiles(r.customProfiles);
        setTemplates(r.templates ?? []);
      })
      .catch(e => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);

  const sorted = useMemo(() => [...profiles].sort(byPriority), [profiles]);
  const hasNewDraft = NEW_KEY in drafts;
  // The selected key can point at a profile that no longer exists: fall back
  // to the first one (WEB-SET-CAMERAS-023, -024).
  const activeKey =
    selectedKey === NEW_KEY && hasNewDraft ? NEW_KEY
      : selectedKey !== null && sorted.some(p => String(p.id) === selectedKey) ? selectedKey
        : sorted[0] ? String(sorted[0].id) : null;
  const activeProfile = activeKey && activeKey !== NEW_KEY ? sorted.find(p => String(p.id) === activeKey) ?? null : null;
  const activeDraft: Draft | null = activeKey === NEW_KEY
    ? drafts[NEW_KEY] ?? null
    : activeProfile ? drafts[activeKey!] ?? draftFromProfile(activeProfile) : null;

  const others: OtherProfile[] = useMemo(
    () => sorted
      .filter(p => String(p.id) !== activeKey)
      .map(p => ({ key: String(p.id), id: p.id, name: p.name, source: p.regex, enabled: p.enabled, priority: p.priority })),
    [sorted, activeKey],
  );

  const dropDraft = (key: string) => setDrafts(d => {
    const next = { ...d };
    delete next[key];
    return next;
  });

  const select = (key: string) => {
    setSelectedKey(key);
    setEditorError('');
  };

  /**
   * WEB-SET-CAMERAS-014. The first switch to Custom (no profiles yet) seeds the
   * vendor templates through the atomic server endpoint BEFORE it saves the
   * mode, so the server is never left in Custom with only part of the
   * templates. If the seeding fails nothing changed. If only the mode save
   * fails, the seeded profiles are inert while the mode is Auto, and a later
   * switch creates no duplicates.
   */
  const onModeChange = async (nextUi: UiMode) => {
    const prev = mode;
    setMode(nextUi); // optimistic
    setModeChanging(true);
    setError(null);
    try {
      if (nextUi === 'custom' && profiles.length === 0 && templates.length > 0) {
        const { customProfiles } = await api.resetCameraProfiles();
        setProfiles(customProfiles);
      }
      await api.setCameraProfileMode(nextUi);
    } catch (e) {
      setMode(prev); // rollback
      setError(errMsg(e));
    } finally {
      setModeChanging(false);
    }
  };

  /** Atomic server reset: delete all custom profiles and seed the templates. */
  const onReset = async () => {
    if (!window.confirm(t('settings.cameraProfiles.resetConfirm'))) return;
    setResetting(true);
    setError(null);
    try {
      const { customProfiles } = await api.resetCameraProfiles();
      setProfiles(customProfiles);
      setDrafts({});
      setSelectedKey(null);
    } catch (e) {
      setError(errMsg(e));
      // Best-effort re-sync so the UI is not left showing a half-applied state.
      try {
        const fresh = await api.getCameraProfiles();
        setProfiles(fresh.customProfiles);
      } catch { /* keep the list */ }
    } finally {
      setResetting(false);
    }
  };

  const onAdd = () => {
    setDrafts(d => ({ ...d, [NEW_KEY]: newDraft(t('settings.cameraProfiles.newProfileName')) }));
    select(NEW_KEY);
  };

  const onSave = async () => {
    if (!activeKey || !activeDraft) return;
    // WEB-SET-CAMERAS-045: refuse locally when the views are being sent out of order.
    const viewsSent = activeKey === NEW_KEY
      || (activeProfile !== null && changedFields(activeDraft, activeProfile).viewsConfig !== undefined);
    if (viewsSent && !viewIdsInOrder(sanitizeViews(activeDraft.views))) {
      setEditorError(t('settings.cameraProfiles.viewsOrderError'));
      return;
    }
    setSaving(true);
    setEditorError('');
    try {
      if (activeKey === NEW_KEY) {
        const created = await api.createCustomProfile({
          name: activeDraft.name.trim(),
          regex: activeDraft.regex.trim(),
          viewsConfig: sanitizeViews(activeDraft.views),
          priority: activeDraft.priority,
        });
        track('settings_change', { setting: 'camera_profile' });
        setProfiles(prev => [...prev, created]);
        dropDraft(NEW_KEY);
        setSelectedKey(String(created.id));
      } else if (activeProfile) {
        const changes = changedFields(activeDraft, activeProfile);
        if (Object.keys(changes).length === 0) return;
        const updated = await api.updateCustomProfile(activeProfile.id, changes);
        track('settings_change', { setting: 'camera_profile' });
        setProfiles(prev => prev.map(p => (p.id === updated.id ? updated : p)));
        dropDraft(activeKey);
      }
    } catch (e) {
      setEditorError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const onRevert = () => {
    if (!activeKey) return;
    dropDraft(activeKey);
    setEditorError('');
    if (activeKey === NEW_KEY) setSelectedKey(null);
  };

  const onDelete = async () => {
    if (!activeProfile) return;
    if (!window.confirm(`${t('settings.cameraProfiles.deleteProfile')} "${activeProfile.name}"?`)) return;
    setSaving(true);
    try {
      await api.deleteCustomProfile(activeProfile.id);
      track('settings_change', { setting: 'camera_profile' });
      setProfiles(prev => prev.filter(p => p.id !== activeProfile.id));
      dropDraft(String(activeProfile.id));
      setSelectedKey(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (p: UserCameraProfile) => {
    setTogglingId(p.id);
    try {
      const updated = await api.updateCustomProfile(p.id, { enabled: !p.enabled });
      track('settings_change', { setting: 'camera_profile' });
      setProfiles(prev => prev.map(x => (x.id === p.id ? updated : x)));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setTogglingId(null);
    }
  };

  const uiMode = toUiMode(mode);

  return (
    <section className="settings-section cp" style={{ marginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: '1rem' }}>{t('settings.cameraProfiles.title')}</h3>
      <p className="settings-hint">{t('settings.cameraProfiles.hint')}</p>

      {loading && <KlipgardLoader />}
      {error && <div className="settings-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!loading && mode !== null && (
        <div style={{ marginBottom: 12 }}>
          <label className="settings-row" style={{ gap: 12 }}>
            <span className="settings-row-label" style={{ minWidth: 120 }}>
              {t('settings.cameraProfiles.modeLabel')}
            </span>
            <select
              value={uiMode ?? 'auto'}
              onChange={e => onModeChange(e.target.value as UiMode)}
              disabled={modeChanging}
              data-testid="camera-profile-mode-select"
              style={SELECT_STYLE}
            >
              {MODE_OPTIONS.map(o => (
                <option key={o.value} value={o.value} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>{t(o.labelKey)}</option>
              ))}
            </select>
          </label>
          {(() => {
            const opt = MODE_OPTIONS.find(o => o.value === uiMode);
            return opt ? <p className="settings-hint" style={{ marginTop: 6 }}>{t(opt.descKey)}</p> : null;
          })()}
        </div>
      )}

      {uiMode === 'custom' && (
        <div>
          <h4 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>{t('settings.cameraProfiles.customProfiles')}</h4>
          <div className="cp-layout">
            <aside className="cp-left">
              <ul className="cp-plist" data-testid="profile-list">
                {sorted.map(p => (
                  <ProfileRow
                    key={p.id}
                    name={p.name}
                    priority={drafts[String(p.id)]?.priority ?? p.priority}
                    enabled={p.enabled}
                    views={p.viewsConfig}
                    selected={String(p.id) === activeKey}
                    unsaved={!!drafts[String(p.id)] && isDirty(drafts[String(p.id)], p)}
                    toggleId={p.id}
                    toggling={togglingId === p.id}
                    onSelect={() => select(String(p.id))}
                    onToggle={() => onToggle(p)}
                  />
                ))}
                {hasNewDraft && (
                  <ProfileRow
                    name={drafts[NEW_KEY].name || t('settings.cameraProfiles.newProfileName')}
                    priority={drafts[NEW_KEY].priority}
                    enabled
                    views={drafts[NEW_KEY].views.map(v => ({ id: v.id, iconKind: v.iconKind }))}
                    selected={activeKey === NEW_KEY}
                    unsaved
                    toggling={false}
                    onSelect={() => select(NEW_KEY)}
                  />
                )}
              </ul>
              {!hasNewDraft && (
                <div className="cp-leftbtns">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={onAdd}
                    disabled={profiles.length >= MAX_PROFILES}
                    data-testid="add-profile-btn"
                  >
                    {t('settings.cameraProfiles.addProfile')}
                  </button>
                  {templates.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={onReset}
                      disabled={resetting}
                      data-testid="reset-profiles-btn"
                    >
                      {t('settings.cameraProfiles.resetToDefaults')}
                    </button>
                  )}
                </div>
              )}
              <p className="cp-hint">{t('settings.cameraProfiles.pg.priorityHint')}</p>
            </aside>

            {activeDraft ? (
              <ProfileEditor
                key={activeKey}
                profile={activeProfile}
                selectedKey={activeKey!}
                draft={activeDraft}
                onDraft={d => setDrafts(prev => ({ ...prev, [activeKey!]: d }))}
                others={others}
                ownNames={ownNames}
                onOwnNames={setOwnNames}
                saving={saving}
                error={editorError}
                onSave={onSave}
                onRevert={onRevert}
                onDelete={onDelete}
              />
            ) : (
              <p className="settings-hint">{t('settings.cameraProfiles.noProfiles')}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
