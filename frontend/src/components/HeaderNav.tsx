import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useHeaderLabelFit } from '../hooks/useHeaderLabelFit';
import { track } from '../lib/analytics';
import { rememberViewMode, viewHref, viewOf, type ViewTarget } from './viewSwitch';

/** The view switch of the signed-in app: Recordings | Timeline, centred in the
 *  header (WEB-SHELL-016, WEB-SHELL-071, WEB-SHELL-072, WEB-SHELL-073). It
 *  replaced the two small icon buttons at the right of each view toolbar, which
 *  owners did not find. Settings is not here: it is the gear of
 *  `HeaderSettingsButton`, its only place in the header (WEB-SHELL-074). */

const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
);
const TimelineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="3" y1="6" x2="10" y2="6"/><line x1="8" y1="12" x2="18" y2="12"/><line x1="5" y1="18" x2="13" y2="18"/><line x1="15" y1="3" x2="15" y2="21" strokeWidth="1.5" opacity="0.55"/></svg>
);
const SettingsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
);

export function HeaderNav() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const current = viewOf(pathname);
  // The label of an item shows only while the row has room for it (WEB-SHELL-080).
  const navRef = useRef<HTMLElement>(null);
  useHeaderLabelFit(navRef);

  const goView = (target: ViewTarget) => (e: React.MouseEvent) => {
    // Let the browser open a new tab on modifier or middle clicks.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (current === target) return;
    if (current !== null) track('view_mode_switch', { to: target });
    rememberViewMode(target);
    navigate(viewHref(target, pathname, search));
  };

  const items: { key: string; href: string; label: string; icon: React.ReactNode; active: boolean; onClick: (e: React.MouseEvent) => void }[] = [
    { key: 'grid', href: viewHref('grid', pathname, search), label: t('nav.recordings'), icon: <GridIcon />, active: current === 'grid', onClick: goView('grid') },
    { key: 'timeline', href: viewHref('timeline', pathname, search), label: t('nav.timeline'), icon: <TimelineIcon />, active: current === 'timeline', onClick: goView('timeline') },
  ];

  return (
    <nav ref={navRef} className="header-switch" aria-label={t('nav.label')}>
      {items.map((it) => (
        <a
          key={it.key}
          href={it.href}
          onClick={it.onClick}
          className={`header-switch-item${it.active ? ' active' : ''}`}
          // A hidden label leaves the icon alone, so the name is kept here.
          aria-label={it.label}
          aria-current={it.active ? 'page' : undefined}
          data-testid={`nav-${it.key}`}
        >
          {it.icon}
          <span>{it.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** The gear at the right of the header: the only way to Settings in the
 *  header, for every role (WEB-SHELL-074). */
export function HeaderSettingsButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname === '/settings' || pathname.startsWith('/settings/');
  return (
    <a
      href="/settings"
      className={`btn btn-sm header-icon-btn${active ? ' active' : ''}`}
      title={t('nav.settings')}
      aria-label={t('nav.settings')}
      aria-current={active ? 'page' : undefined}
      data-testid="header-settings"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        if (!active) navigate('/settings');
      }}
    >
      <SettingsIcon />
    </a>
  );
}
