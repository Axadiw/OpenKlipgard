import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { LoginPage } from './LoginPage';
import { renderWithRouter } from '../test-utils';
import { I18nProvider } from '../i18n';

// The self-hosted edition: the logo must render there too, from the shared tree.
vi.mock('../edition', async () => await import('../editions/selfhost'));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));

describe('LoginPage logo', () => {
  it('[WEB-SHELL-068] the sign-in heading is the logo alone, about 48 px, with no app icon above it', () => {
    const { container } = renderWithRouter(<I18nProvider><LoginPage /></I18nProvider>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Klipgard' });
    const logo = heading.querySelector('svg.klipgard-logo');
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute('height', '48');
    expect(container.querySelector('img')).toBeNull();
  });
});
