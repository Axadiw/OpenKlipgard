import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { story } from '../test-story';
import { Header } from './Header';

const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'a@b.c' }, logout: vi.fn(), isAdmin: auth.isAdmin }),
}));
const operator = vi.hoisted(() => ({ home: '/admin/overview' as string | null }));
vi.mock('../edition', () => ({ edition: { get operatorHome() { return operator.home; } } }));
vi.mock('./NotificationsBell', () => ({ NotificationsBell: () => null }));
vi.mock('../hooks/usePwaInstall', () => ({ usePwaInstall: () => ({ canPromptInstall: false, install: vi.fn() }) }));

describe('Header logo', () => {
  it('[WEB-SHELL-015] [WEB-SHELL-068] draws the logo, 28 px tall, as the linked title, with no app icon next to it', () => {
    const { container } = render(<I18nProvider><MemoryRouter><Header /></MemoryRouter></I18nProvider>);
    const title = screen.getByRole('heading', { level: 1, name: 'Klipgard' });
    const logo = title.querySelector('svg.klipgard-logo');
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute('height', '28');
    expect(screen.getByRole('img', { name: 'Klipgard' })).toBe(logo);
    expect(title.closest('a')).toHaveAttribute('href', '/grid');
    // The logo already holds the K: no icon image anywhere in the header.
    expect(container.querySelector('header img')).toBeNull();
  });
});

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAt(url: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[url]}>
        <Header />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('Header nav [WEB-SHELL-071]', () => {
  beforeEach(() => { auth.isAdmin = false; operator.home = '/admin/overview'; localStorage.clear(); });

  it('switches between Recordings and Timeline and marks the current view', () => {
    renderAt('/timeline');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(links).toEqual(['Recordings', 'Timeline']);
    expect(screen.getByTestId('nav-timeline').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-grid').getAttribute('aria-current')).toBeNull();
  });

  it('has one way to Settings: the gear, current on every settings page [WEB-SHELL-074]', () => {
    renderAt('/settings/storage');
    const gear = screen.getByRole('link', { name: 'Settings' });
    expect(gear.getAttribute('data-testid')).toBe('header-settings');
    expect(gear.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-grid').getAttribute('aria-current')).toBeNull();
  });

  it('opens Settings from the gear and keeps Settings out of the account menu [WEB-SHELL-018]', () => {
    renderAt('/grid');
    fireEvent.click(screen.getByTestId('account-menu-button'));
    expect(screen.queryByRole('menuitem', { name: /^settings$/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /logout/i })).toBeTruthy();
    fireEvent.click(screen.getByTestId('header-settings'));
    expect(screen.getByTestId('where').textContent).toBe('/settings');
  });

  it('shows the first letter of the e-mail on the account button [WEB-SHELL-017]', () => {
    renderAt('/grid');
    expect(screen.getByTestId('account-menu-button').textContent).toBe('A');
  });

  it('switches timeline → grid, drops the timeline-only params and remembers the mode [WEB-SHELL-072]', () => {
    renderAt('/timeline?cameras=Front&date=2026-11-12&event=e1&t=3');
    fireEvent.click(screen.getByTestId('nav-grid'));
    expect(screen.getByTestId('where').textContent).toBe('/grid?cameras=Front');
    expect(localStorage.getItem('viewMode')).toBe('grid');
  });

  it('does nothing when the current item is clicked', () => {
    renderAt('/grid?cameras=Front');
    fireEvent.click(screen.getByTestId('nav-grid'));
    expect(screen.getByTestId('where').textContent).toBe('/grid?cameras=Front');
    expect(localStorage.getItem('viewMode')).toBeNull();
  });

  it('is hidden for an administrator when the edition has an operator home, the gear stays', () => {
    auth.isAdmin = true;
    renderAt('/admin/overview');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByTestId('header-settings')).toBeTruthy();
  });

  it('is shown for an administrator when the edition has no operator home', () => {
    auth.isAdmin = true; operator.home = null;
    renderAt('/grid');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });
});

describe('Header account menu [WEB-050]', () => {
  beforeEach(() => { auth.isAdmin = false; operator.home = '/admin/overview'; localStorage.clear(); });

  it('[WEB-041] the account button announces a menu and the menu has menu items', (ctx) => {
    story(ctx, 'Przycisk konta w nagłówku ma nazwę dla czytnika ekranu, zapowiada menu (aria-haspopup) i zgłasza, czy jest otwarte (aria-expanded); otwarte menu ma role menu i pozycje menu.');
    renderAt('/grid');
    const button = screen.getByTestId('account-menu-button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });

  it('[WEB-050] Escape closes the open menu', (ctx) => {
    story(ctx, 'Naciśnięcie Escape zamyka otwarte menu konta w nagłówku, tak jak kliknięcie poza nim.');
    renderAt('/grid');
    const button = screen.getByTestId('account-menu-button');
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
