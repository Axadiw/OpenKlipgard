import { useId, useMemo } from 'react';
import type { UserCameraProfile } from '../../api';
import { useTranslation } from '../../i18n';
import {
  EXAMPLE_FILENAMES, MAX_OWN_NAMES, REQUIRED_GROUPS, groupClass, parseMatch, validatePattern,
} from '../../lib/cameraPattern';
import { ExamplesList } from './ExamplesList';
import type { ExampleRow } from './ExamplesList';
import { PatternField } from './PatternField';
import { ViewsEditor } from './ViewsEditor';
import { byPriority, changedFields, sanitizeViews } from './draft';
import type { Draft } from './draft';
import { resultKey, usePatternPreview } from './usePatternPreview';

export interface OtherProfile {
  key: string;
  id: number;
  name: string;
  source: string;
  enabled: boolean;
  priority: number;
}

interface Props {
  /** The stored profile, or null for a draft of a new profile. */
  profile: UserCameraProfile | null;
  selectedKey: string;
  draft: Draft;
  onDraft: (next: Draft) => void;
  others: OtherProfile[];
  ownNames: string[];
  onOwnNames: (next: string[]) => void;
  saving: boolean;
  error: string;
  onSave: () => void;
  /** Revert (saved profile) or Discard (new draft). */
  onRevert: () => void;
  onDelete: () => void;
}

/**
 * The right-hand side of the Cameras tab in Custom mode: header, pattern
 * field, live examples, required-groups checklist and views editor
 * (WEB-SET-CAMERAS-070..084).
 */
export function ProfileEditor({
  profile, selectedKey, draft, onDraft, others, ownNames, onOwnNames, saving, error, onSave, onRevert, onDelete,
}: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const patId = `${uid}-pattern`;
  const statusId = `${uid}-status`;
  const isNew = profile === null;

  const check = useMemo(() => validatePattern(draft.regex), [draft.regex]);
  const names = useMemo(() => [...EXAMPLE_FILENAMES, ...ownNames], [ownNames]);
  const preview = usePatternPreview(
    { key: selectedKey, source: check.error ? '' : draft.regex },
    others.map(o => ({ key: o.key, source: o.source })),
    names,
  );
  const refused = check.error !== null || preview.state === 'slow';

  // The first enabled profile by priority that matches wins (WEB-SET-CAMERAS-078).
  const candidates = useMemo(() => {
    const self = {
      key: selectedKey,
      id: profile?.id ?? Number.MAX_SAFE_INTEGER,
      name: draft.name,
      enabled: profile?.enabled ?? true,
      priority: draft.priority,
    };
    return [self, ...others].sort(byPriority);
  }, [selectedKey, profile, draft.name, draft.priority, others]);

  const rows: ExampleRow[] = names.map((name, i) => {
    const winner = candidates.find(c => c.enabled
      && !(c.key === selectedKey && refused)
      && preview.results[resultKey(c.key, name)]?.status === 'match');
    return {
      name,
      own: i >= EXAMPLE_FILENAMES.length,
      result: preview.results[resultKey(selectedKey, name)],
      winner: winner ? { key: winner.key, name: winner.name } : null,
    };
  });

  const matchedRows = rows.filter(r => !refused && r.result?.status === 'match');
  const tsBad = !refused && rows.some(r => r.result?.status === 'nomatch' && r.result.reason === 'tsDigits');
  const usage = (viewId: string) => matchedRows.filter(r => {
    if (r.result?.status !== 'match') return false;
    const m = parseMatch(r.name, r.result);
    return (m.view ?? draft.views[0]?.id.trim() ?? '00') === viewId;
  }).length;

  let status: React.ReactNode;
  let statusKind: 'err' | 'ok' | 'wait' = 'err';
  if (check.error) {
    const e = check.error;
    status = e.kind === 'empty' ? t('settings.cameraProfiles.pg.status.empty')
      : e.kind === 'tooLong' ? t('settings.cameraProfiles.pg.status.tooLong')
      : e.kind === 'syntax' ? t('settings.cameraProfiles.pg.status.syntax', { detail: e.detail ?? '' })
      : t('settings.cameraProfiles.pg.status.groups', { groups: check.missing.join(', ') });
  } else if (preview.state === 'slow') {
    status = t('settings.cameraProfiles.pg.status.slow');
  } else if (preview.state === 'unavailable') {
    status = t('settings.cameraProfiles.pg.status.unavailable');
  } else if (preview.state !== 'ready') {
    status = '…';
    statusKind = 'wait';
  } else {
    status = t('settings.cameraProfiles.pg.status.valid', { matched: matchedRows.length, total: names.length });
    statusKind = 'ok';
  }

  const priorityOk = Number.isInteger(draft.priority) && draft.priority >= 1 && draft.priority <= 999;
  const dirty = isNew || (profile !== null && Object.keys(changedFields(draft, profile)).length > 0);
  const canSave = dirty && !saving && draft.name.trim().length > 0 && draft.regex.trim().length > 0
    && check.error === null && priorityOk && sanitizeViews(draft.views).length <= 16;

  const hasGroup = (g: string) => check.groups.includes(g);
  const reqNote: Record<string, string> = {
    camera: t('settings.cameraProfiles.pg.req.camera'),
    ts: t('settings.cameraProfiles.pg.req.ts'),
    ext: t('settings.cameraProfiles.pg.req.ext'),
  };
  const hasView = hasGroup('view') || hasGroup('lens');

  return (
    <section className="cp-work" aria-label={draft.name || t('settings.cameraProfiles.newProfileName')} data-testid="profile-editor">
      <form
        className="cp-edhead"
        onSubmit={e => { e.preventDefault(); if (canSave) onSave(); }}
      >
        <label className="cp-namebox">
          <span className="cp-sr">{t('settings.cameraProfiles.profileName')}</span>
          <input
            type="text"
            className="cp-input cp-nameinp"
            value={draft.name}
            maxLength={200}
            placeholder={t('settings.cameraProfiles.profileName')}
            onChange={e => onDraft({ ...draft, name: e.target.value })}
            data-testid="profile-name-input"
          />
        </label>
        <label className="cp-prio">
          <span className="cp-hint">{t('settings.cameraProfiles.profilePriority')}</span>
          <input
            type="number"
            className="cp-input"
            min={1}
            max={999}
            value={Number.isNaN(draft.priority) ? '' : draft.priority}
            onChange={e => onDraft({ ...draft, priority: e.target.value === '' ? NaN : Number(e.target.value) })}
            data-testid="profile-priority-input"
          />
        </label>
        <span className="cp-spacer" />
        <button type="button" className="btn btn-sm" onClick={onRevert} disabled={saving || (!isNew && !dirty)} data-testid="profile-revert-btn">
          {isNew ? t('settings.cameraProfiles.discardProfile') : t('settings.cameraProfiles.revertProfile')}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!canSave} data-testid="profile-save-btn">
          {t('settings.cameraProfiles.saveProfile')}
        </button>
        {!isNew && (
          <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} disabled={saving} data-testid="profile-delete-btn">
            {t('settings.cameraProfiles.deleteProfile')}
          </button>
        )}
      </form>

      <PatternField
        id={patId}
        value={draft.regex}
        onChange={regex => onDraft({ ...draft, regex })}
        invalid={check.error !== null}
        describedBy={statusId}
      />
      <div className="cp-under">
        <div id={statusId} className={`cp-status is-${statusKind}`} role="status" data-testid="pattern-status">{status}</div>
      </div>
      <p className="cp-hint cp-regexhint">{t('settings.cameraProfiles.regexHint')}</p>
      {error && <div className="cp-saverr" role="alert" data-testid="profile-save-error">{error}</div>}

      <div className="cp-cols">
        <ExamplesList
          rows={rows}
          selectedKey={selectedKey}
          views={draft.views}
          refused={refused}
          onAddOwn={name => {
            if (ownNames.includes(name) || EXAMPLE_FILENAMES.includes(name) || ownNames.length >= MAX_OWN_NAMES) return;
            onOwnNames([...ownNames, name]);
          }}
          onRemoveOwn={name => onOwnNames(ownNames.filter(n => n !== name))}
        />
        <div className="cp-side">
          <div className="cp-box">
            <h4>{t('settings.cameraProfiles.pg.required')}</h4>
            <ul className="cp-req" data-testid="required-groups">
              {REQUIRED_GROUPS.map(g => (
                <li key={g} className={hasGroup(g) ? 'is-ok' : 'is-no'} data-testid={`req-${g}`}>
                  <i aria-hidden="true">{hasGroup(g) ? '✓' : '×'}</i>
                  <code className={`g-${groupClass(g)}`}>{g}</code>
                  <span>{reqNote[g]}</span>
                  <span className="cp-sr">{hasGroup(g) ? t('settings.cameraProfiles.pg.req.present') : t('settings.cameraProfiles.pg.req.missing')}</span>
                </li>
              ))}
              <li className={hasView ? 'is-ok' : 'is-opt'} data-testid="req-view">
                <i aria-hidden="true">{hasView ? '✓' : '·'}</i>
                <code className="g-view">view</code>
                <span>
                  {hasView
                    ? t('settings.cameraProfiles.pg.req.viewOptional')
                    : t('settings.cameraProfiles.pg.req.viewAbsent', { id: draft.views[0]?.id.trim() || '00' })}
                </span>
              </li>
            </ul>
            {tsBad && <div className="cp-note">{t('settings.cameraProfiles.pg.tsNote')}</div>}
          </div>
          <ViewsEditor views={draft.views} onChange={views => onDraft({ ...draft, views })} usage={usage} />
        </div>
      </div>
    </section>
  );
}
