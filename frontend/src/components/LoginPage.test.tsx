import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act, fireEvent } from '@testing-library/react';
import { LoginPage } from './LoginPage';
import { renderWithRouter } from '../test-utils';
import { api, ApiError } from '../api';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params && 'time' in params ? `${key} ${params.time}` : key,
  }),
}));
// Password-only sign-in (no passkey pre-flight), as in the self-hosted edition.
vi.mock('../edition', async () => await import('../editions/selfhost'));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));

describe('LoginPage — rate-limit countdown on password submit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shows a ticking countdown when the password endpoint returns 429', async (ctx) => {
    story(ctx, 'Limit logowania (10 prób / 15 min) na /auth/login wpadał dotąd w generyczne "błąd logowania". Teraz użytkownik widzi konkretne "Spróbuj ponownie za 0:40" — i to samo, niezależnie czy padł limiter per-IP czy per-email (brak oracle enumeracji kont).');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('rl', 429, undefined, 40));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });

    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByText(/login\.rateLimitedWait 0:40/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/0:39/)).toBeInTheDocument();
  });
});

describe('LoginPage — account lock countdown on password submit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const submit = async () => {
    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });
  };

  it('[WEB-AUTH-009] a 423 with Retry-After starts the same ticking countdown with the lock wording', async (ctx) => {
    story(ctx, 'Zablokowane konto (423 z Retry-After) uruchamia ten sam odliczający licznik co limit żądań, ale z tekstem „Dostęp wróci za 2:00” zamiast statycznego komunikatu.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('locked', 423, undefined, 120));

    await submit();

    expect(screen.getByText(/login\.lockedWait 2:00/)).toBeInTheDocument();
    expect(screen.queryByText(/login\.rateLimitedWait/)).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/login\.lockedWait 1:59/)).toBeInTheDocument();
  });

  it('[WEB-AUTH-009] a 423 without Retry-After shows the static locked message', async (ctx) => {
    story(ctx, 'Gdy 423 przyjdzie bez nagłówka Retry-After, nie zmyślamy odliczania — zostaje statyczny komunikat o blokadzie.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('locked', 423));

    await submit();

    expect(screen.getByText('login.locked')).toBeInTheDocument();
    expect(screen.queryByText(/login\.lockedWait/)).toBeNull();
  });

  it('[WEB-AUTH-009] a 429 after the lock countdown ended uses the rate-limit wording again', async (ctx) => {
    story(ctx, 'Po upływie blokady kolejny limit żądań (429) znów pokazuje komunikat o zbyt wielu próbach, nie tekst o blokadzie.');
    const login = vi.spyOn(api, 'login').mockRejectedValueOnce(new ApiError('locked', 423, undefined, 2));

    await submit();
    expect(screen.getByText(/login\.lockedWait 0:02/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    login.mockRejectedValueOnce(new ApiError('rl', 429, undefined, 40));
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByText(/login\.rateLimitedWait 0:40/)).toBeInTheDocument();
  });
});

describe('LoginPage — after the e-mail confirmation link', () => {
  it('says the account can sign in when the link marks it ready', (ctx) => {
    story(ctx, 'Konto z opłaconym planem jest aktywne od rejestracji — po potwierdzeniu adresu (?verified=1&ready=1) strona logowania mówi „możesz się zalogować”, a nie „czekaj na admina”.');
    renderWithRouter(<LoginPage />, { route: '/login?verified=1&ready=1' });
    expect(screen.getByText('login.verifiedReady')).toBeInTheDocument();
    expect(screen.queryByText('login.verifiedSuccess')).toBeNull();
  });

  it('keeps the awaiting-activation copy for other accounts', (ctx) => {
    story(ctx, 'Bez ready=1 (zwykła rejestracja czekająca na admina) komunikat zostaje bez zmian.');
    renderWithRouter(<LoginPage />, { route: '/login?verified=1' });
    expect(screen.getByText('login.verifiedSuccess')).toBeInTheDocument();
  });
});

describe('LoginPage — an address that is not confirmed yet', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('asks to confirm the address instead of showing a generic error', async (ctx) => {
    story(ctx, 'Gdy serwer odmawia logowania kodem 403 EMAIL_NOT_VERIFIED (poprawne hasło, niepotwierdzony adres), strona logowania pokazuje „Potwierdź adres e-mail — wysłaliśmy Ci link” zamiast „konto czeka na admina” czy ogólnego błędu.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Confirm your e-mail address first', 403, { code: 'EMAIL_NOT_VERIFIED' }));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByTestId('login-email-not-verified')).toHaveTextContent('login.emailNotVerified');
    expect(screen.queryByText('login.inactive')).toBeNull();
    expect(screen.queryByText('login.error')).toBeNull();
  });

  it('keeps the activation copy for any other 403', async (ctx) => {
    story(ctx, 'Inne 403 (bez kodu EMAIL_NOT_VERIFIED) nadal pokazują dotychczasowy komunikat o aktywacji.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Forbidden', 403, {}));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByText('login.inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('login-email-not-verified')).toBeNull();
  });
});

describe('LoginPage — passkey sign-in without asking the server which method', () => {
  const challenge = { sessionId: 'sess-1', options: { challenge: 'c' } };
  const start = vi.fn();
  const fromPasskeyRequired = vi.fn();
  const Stage = vi.fn(({ email, challenge: c }: { email: string; challenge: { sessionId: string } }) => (
    <div data-testid="passkey-stage">{email}|{c.sessionId}</div>
  ));

  beforeEach(async () => {
    vi.resetModules();
    start.mockReset();
    fromPasskeyRequired.mockReset();
    Stage.mockClear();
    localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('../edition'); });

  async function renderWithPasskeyEdition() {
    vi.doMock('../edition', async () => {
      const base = await import('../editions/selfhost');
      return { edition: { ...base.edition, login: { ...base.edition.login, passkey: { start, fromPasskeyRequired, Stage, BackupStage: () => null } } } };
    });
    const { LoginPage: Page } = await import('./LoginPage');
    const { api: freshApi } = await import('../api');
    const utils = renderWithRouter(<Page />);
    return { ...utils, freshApi };
  }

  const toCredentials = async () => {
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'A@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
  };

  it('the credentials step offers both password and passkey without calling the server', async (ctx) => {
    story(ctx, 'Po wpisaniu e-maila strona od razu pokazuje pole hasła i przycisk passkey — bez żadnego zapytania do serwera, więc serwer nie zdradza, jakiego sposobu logowania używa dane konto.');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await renderWithPasskeyEdition();
    await toCredentials();
    expect(screen.getByPlaceholderText('login.password')).toBeInTheDocument();
    expect(screen.getByTestId('login-use-passkey')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the passkey button asks for a challenge for the typed e-mail and shows the passkey stage', async (ctx) => {
    story(ctx, 'Przycisk passkey pobiera wyzwanie (login/start) i uruchamia ceremonię; e-mail trafia dalej do /login/passkey, który wiąże klucz z tym kontem.');
    start.mockResolvedValue(challenge);
    await renderWithPasskeyEdition();
    await toCredentials();
    await act(async () => { fireEvent.click(screen.getByTestId('login-use-passkey')); });
    expect(start).toHaveBeenCalled();
    expect(screen.getByTestId('passkey-stage')).toHaveTextContent('a@b.co|sess-1');
  });

  it('a 400 passkeyRequired starts the ceremony with the challenge from the 400 body', async (ctx) => {
    story(ctx, 'Hasło wpisane przez przyzwyczajenie na koncie z passkey nie odsyła do kroku e-mail (stara pętla): strona od razu uruchamia passkey z wyzwaniem dołączonym do odpowiedzi 400.');
    fromPasskeyRequired.mockReturnValue(challenge);
    const { freshApi } = await renderWithPasskeyEdition();
    const { ApiError: FreshApiError } = await import('../api');
    vi.spyOn(freshApi, 'login').mockRejectedValue(new FreshApiError('Use passkey', 400, { passkeyRequired: true, ...challenge }));
    await toCredentials();
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });
    expect(fromPasskeyRequired).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId('passkey-stage')).toHaveTextContent('a@b.co|sess-1');
    expect(screen.queryByPlaceholderText('login.email')).toBeNull();
  });

  it('a 400 passkeyRequired without a challenge asks the edition for one', async (ctx) => {
    story(ctx, 'Gdy serwer nie dołączył wyzwania do 400 (starszy serwer), strona prosi o nie osobno, zamiast wracać do kroku e-mail.');
    fromPasskeyRequired.mockReturnValue(null);
    start.mockResolvedValue(challenge);
    const { freshApi } = await renderWithPasskeyEdition();
    const { ApiError: FreshApiError } = await import('../api');
    vi.spyOn(freshApi, 'login').mockRejectedValue(new FreshApiError('Use passkey', 400, { passkeyRequired: true }));
    await toCredentials();
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });
    expect(start).toHaveBeenCalled();
    expect(screen.getByTestId('passkey-stage')).toBeInTheDocument();
  });
});
