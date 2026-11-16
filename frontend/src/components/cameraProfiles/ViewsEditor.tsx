import { useId } from 'react';
import type { IconKind } from '../../types';
import { ViewIcon, VIEW_ICON_KINDS } from '../ViewIcon';
import { useTranslation } from '../../i18n';
import { MAX_VIEWS } from '../../lib/cameraPattern';
import type { ViewConfigEntry } from './draft';

interface Props {
  views: ViewConfigEntry[];
  onChange: (next: ViewConfigEntry[]) => void;
  /** Number of examples that use each view id (WEB-SET-CAMERAS-044). */
  usage: (viewId: string) => number;
}

/**
 * Ordered view rows (WEB-SET-CAMERAS-040..044): live icon preview, view id,
 * icon radio group (native radios, so the arrow keys work) and remove button.
 */
export function ViewsEditor({ views, onChange, usage }: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const update = (i: number, patch: Partial<ViewConfigEntry>) =>
    onChange(views.map((v, k) => (k === i ? { ...v, ...patch } : v)));

  return (
    <div className="cp-box" data-testid="profile-views-editor">
      <div className="cp-vhead">
        <h4>{t('settings.cameraProfiles.viewsLabel')}</h4>
        <span className="cp-hint">{t('settings.cameraProfiles.pg.viewsHint', { max: MAX_VIEWS })}</span>
      </div>
      <div className="cp-views">
        {views.map((v, i) => (
          <div className="cp-view" key={i} data-testid={`profile-view-row-${i}`}>
            <span className="cp-vprev" aria-hidden="true"><ViewIcon kind={v.iconKind} size={22} /></span>
            <input
              type="text"
              className="cp-input cp-vid"
              value={v.id}
              maxLength={16}
              placeholder={i === 0 ? '00' : '01'}
              aria-label={`${t('settings.cameraProfiles.profileView')} ${i + 1}`}
              onChange={e => update(i, { id: e.target.value })}
              data-testid={`profile-view-id-${i}`}
            />
            <span className="cp-used" title={t('settings.cameraProfiles.pg.viewUsed')}>
              {usage(v.id.trim())}×
            </span>
            {views.length > 1 ? (
              <button
                type="button"
                className="cp-iconbtn"
                aria-label={t('settings.cameraProfiles.removeView')}
                title={t('settings.cameraProfiles.removeView')}
                onClick={() => onChange(views.filter((_, k) => k !== i))}
                data-testid={`profile-view-remove-${i}`}
              >
                ×
              </button>
            ) : <span />}
            <div
              className="cp-icons"
              role="radiogroup"
              aria-label={t('settings.cameraProfiles.viewIconLabel')}
            >
              {VIEW_ICON_KINDS.map((kind: IconKind) => (
                <label
                  key={kind}
                  className={v.iconKind === kind ? 'is-on' : ''}
                  title={t(`profile.viewIcon.${kind}`)}
                >
                  <input
                    type="radio"
                    className="cp-sr"
                    name={`${uid}-icon-${i}`}
                    checked={v.iconKind === kind}
                    aria-label={t(`profile.viewIcon.${kind}`)}
                    onChange={() => update(i, { iconKind: kind })}
                    data-testid={`profile-view-icon-${i}-${kind}`}
                  />
                  <ViewIcon kind={kind} size={16} />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        style={{ marginTop: 10 }}
        disabled={views.length >= MAX_VIEWS}
        onClick={() => onChange([...views, { id: '', iconKind: 'generic' }])}
        data-testid="profile-view-add"
      >
        {t('settings.cameraProfiles.addView')}
      </button>
    </div>
  );
}
