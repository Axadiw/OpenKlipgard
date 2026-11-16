import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { story } from '../../test-story';

const authState = vi.hoisted(() => ({ isAdmin: false, logoutEverywhere: vi.fn() }));
const apiMocks = vi.hoisted(() => ({
  getAccountTimezone: vi.fn(),
  setAccountTimezone: vi.fn(),
}));

vi.mock('../../context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../api', () => ({ api: apiMocks }));
vi.mock('../../i18n', () => ({
  LANGUAGES: [{ code: 'en', label: 'English' }],
  useTranslation: () => ({ t: (k: string) => k, language: 'en', setLanguage: vi.fn() }),
}));
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ mode: 'auto', setMode: vi.fn() }) }));
vi.mock('../../hooks/usePwaInstall', () => ({ usePwaInstall: () => ({ showIosHint: false }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { GeneralTab } from './GeneralTab';

describe('GeneralTab timezone row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getAccountTimezone.mockResolvedValue({ timezone: 'Europe/Warsaw' });
  });

  it('WEB-SET-GENERAL-025: an operator does not see the Timezone row and the zone is never read', (ctx) => {
    story(ctx, 'Serwer odmawia operatorowi odczytu i zapisu strefy czasowej, więc wiersz strefy jest ukryty — nie pokazuje wiecznie UTC i nie cofa zmian. Sekcja sesji zostaje.');
    authState.isAdmin = true;
    render(<GeneralTab />);
    expect(screen.queryByText('settings.timezone')).not.toBeInTheDocument();
    expect(apiMocks.getAccountTimezone).not.toHaveBeenCalled();
    expect(screen.getByTestId('sessions-section')).toBeInTheDocument();
  });

  it('WEB-SET-GENERAL-020: an owner sees the Timezone row', async (ctx) => {
    story(ctx, 'Właściciel kamer nadal widzi selektor strefy czasowej konta.');
    authState.isAdmin = false;
    render(<GeneralTab />);
    expect(screen.getByText('settings.timezone')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Europe/Warsaw')).toBeInTheDocument();
  });
});
