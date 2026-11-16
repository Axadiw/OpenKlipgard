import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { JobResult } from '../../lib/cameraPattern';
import { MAX_FILENAME, MAX_OWN_NAMES, fmtTs, groupClass, parseMatch } from '../../lib/cameraPattern';
import { ViewIcon } from '../ViewIcon';
import type { ViewConfigEntry } from './draft';

export interface ExampleRow {
  name: string;
  own: boolean;
  /** undefined while no result exists yet. */
  result?: JobResult;
  winner: { key: string; name: string } | null;
}

interface Props {
  rows: ExampleRow[];
  selectedKey: string;
  views: ViewConfigEntry[];
  /** The pattern is refused: every example is "not a match". */
  refused: boolean;
  onAddOwn: (name: string) => void;
  onRemoveOwn: (name: string) => void;
}

/**
 * Example file names that re-colour as the pattern changes
 * (WEB-SET-CAMERAS-074..079).
 */
export function ExamplesList({ rows, selectedKey, views, refused, onAddOwn, onRemoveOwn }: Props) {
  const { t } = useTranslation();
  const [own, setOwn] = useState('');
  const ownCount = rows.filter(r => r.own).length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = own.trim();
    if (!name) return;
    onAddOwn(name);
    setOwn('');
  };

  return (
    <div className="cp-play">
      <div className="cp-ph">
        <h4>{t('settings.cameraProfiles.pg.examples')}</h4>
        <div className="cp-legend" aria-hidden="true">
          <span className="g-camera">{t('settings.cameraProfiles.pg.legend.camera')}</span>
          <span className="g-view">{t('settings.cameraProfiles.pg.legend.view')}</span>
          <span className="g-ts">{t('settings.cameraProfiles.pg.legend.ts')}</span>
          <span className="g-ext">{t('settings.cameraProfiles.pg.legend.ext')}</span>
        </div>
      </div>
      <ul className="cp-files" data-testid="example-list">
        {rows.map(row => {
          const r = refused ? undefined : row.result;
          const matched = r?.status === 'match' ? parseMatch(row.name, r) : null;
          const viewId = matched ? (matched.view ?? views[0]?.id ?? '00') : null;
          const viewDef = viewId !== null ? views.find(v => v.id.trim() === viewId) : undefined;
          const state = matched ? 'ok' : (refused || r) ? 'no' : 'wait';
          const reason = refused || r?.status === 'error' ? 'refused' : r?.status === 'nomatch' ? r.reason : 'generic';
          return (
            <li key={row.name} className={`cp-file is-${state}`} data-testid="example-row" data-state={state}>
              <div className="cp-frow">
                <span className="cp-ficon" aria-hidden="true">
                  {matched ? <ViewIcon kind={viewDef?.iconKind ?? 'generic'} size={18} /> : state === 'no' ? <span className="cp-x">×</span> : null}
                </span>
                <code className="cp-fname" title={row.name}>
                  {matched
                    ? matched.segs.map((s, i) => (
                      s.group
                        ? <span key={i} className={`cp-seg g-${groupClass(s.group)}`} title={s.group}>{s.text}</span>
                        : <span key={i}>{s.text}</span>
                    ))
                    : row.name}
                </code>
                {!refused && row.winner && (
                  <span
                    className={`cp-win${row.winner.key === selectedKey ? ' is-me' : ''}`}
                    title={t('settings.cameraProfiles.pg.winnerTitle')}
                    data-testid="example-winner"
                  >
                    {row.winner.key === selectedKey
                      ? t('settings.cameraProfiles.pg.winsThis')
                      : t('settings.cameraProfiles.pg.winsOther', { name: row.winner.name })}
                  </span>
                )}
                {row.own && (
                  <button
                    type="button"
                    className="cp-iconbtn"
                    onClick={() => onRemoveOwn(row.name)}
                    aria-label={t('settings.cameraProfiles.pg.removeOwn', { name: row.name })}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="cp-fsub">
                {matched ? (
                  <>
                    <span>{t('settings.cameraProfiles.pg.legend.camera')} <b className="g-camera">{matched.camera}</b></span>
                    <span>
                      {t('settings.cameraProfiles.pg.legend.view')} <b className="g-view">{viewId}</b>
                      {' · '}{viewDef ? t(`profile.viewIcon.${viewDef.iconKind}`) : t('settings.cameraProfiles.pg.noIcon')}
                    </span>
                    <span>{t('settings.cameraProfiles.pg.legend.ts')} <b className="g-ts">{fmtTs(matched.ts)}</b></span>
                  </>
                ) : state === 'no' ? (
                  <span className="cp-why">
                    {t(`settings.cameraProfiles.pg.reason.${reason}`)}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <form className="cp-add" onSubmit={submit}>
        <input
          type="text"
          className="cp-input cp-mono"
          value={own}
          maxLength={MAX_FILENAME}
          placeholder={t('settings.cameraProfiles.pg.ownName')}
          aria-label={t('settings.cameraProfiles.pg.ownName')}
          onChange={e => setOwn(e.target.value)}
          data-testid="regex-test-filename"
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={!own.trim() || ownCount >= MAX_OWN_NAMES}
          data-testid="own-name-add"
        >
          {t('settings.cameraProfiles.pg.ownTest')}
        </button>
      </form>
    </div>
  );
}
