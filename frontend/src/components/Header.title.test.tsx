import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Header } from './Header';

// A catalog that names the product differently (WEB-SHELL-070).
vi.mock('../i18n', () => ({
  useTranslation: () => ({ t: (k: string) => (k === 'header.title' ? 'My cameras' : k), language: 'en' }),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'a@b.c' }, logout: vi.fn(), isAdmin: false }),
}));
vi.mock('../edition', () => ({ edition: { operatorHome: null } }));
vi.mock('./NotificationsBell', () => ({ NotificationsBell: () => null }));
vi.mock('../hooks/usePwaInstall', () => ({ usePwaInstall: () => ({ canPromptInstall: false, install: vi.fn() }) }));

describe('Header title from another catalog', () => {
  it('[WEB-SHELL-070] renders a title other than "Klipgard" as plain text, with no logo', () => {
    const { container } = render(<MemoryRouter><Header /></MemoryRouter>);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.textContent).toBe('My cameras');
    expect(container.querySelector('.klipgard-logo')).toBeNull();
  });

  it('[WEB-SHELL-080] lets a title drawn as text shrink: only the logo link keeps its width', () => {
    const { container } = render(<MemoryRouter><Header /></MemoryRouter>);
    expect(container.querySelector('a.header-brand')).not.toHaveClass('header-brand-logo');
  });
});
