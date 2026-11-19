import { useTranslation } from '../i18n';

interface Props {
  visible: boolean;
  onTop: () => void;
  onBottom: () => void;
}

/** The thin bottom bar of WEB-GRID-123: jump to the top, or to the end of the
 *  page (the footer) with the infinite scroll paused. A hidden bar is inert,
 *  so neither its buttons nor its labels reach keyboard or screen readers. */
export function GridScrollBar({ visible, onTop, onBottom }: Props) {
  const { t } = useTranslation();
  return (
    <div className={`grid-scroll-bar${visible ? ' is-visible' : ''}`} inert={!visible} data-testid="grid-scroll-bar">
      <button type="button" className="grid-scroll-btn" onClick={onTop}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
        <span>{t('events.scrollTop')}</span>
      </button>
      <button type="button" className="grid-scroll-btn" onClick={onBottom}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        <span>{t('events.scrollBottom')}</span>
      </button>
    </div>
  );
}
