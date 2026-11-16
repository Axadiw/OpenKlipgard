import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, getRememberMe, type OAuthResult } from '../api';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from '../i18n';
import { edition } from '../edition';
import type { PasskeyChallenge } from '../editions/types';
import { VersionFooter } from './VersionFooter';
import { Wordmark } from './Wordmark';
import { useCountdown } from '../hooks/useCountdown';
import { formatDuration } from '../utils/format';
import { hasPasskeyHint, setPasskeyHint } from '../utils/passkeyHint';
import { analyticsErrorCode, track } from '../lib/analytics';

interface BanInfo {
  until: string | null;
  reason: string | null;
  indefinite: boolean;
}

type Stage = 'email' | 'credentials' | 'passkey' | 'backup';

/**
 * Two-stage login:
 *
 * 1. User types email. Nothing is sent: the server is never asked which
 *    method an account uses (that answer was an account-existence oracle).
 * 2. Credentials: a password field and, when the edition supports passkeys, a
 *    "Sign in with a passkey" button. The button asks the edition for an
 *    anonymous challenge, runs the WebAuthn ceremony (the edition's passkey
 *    stage) and posts the result with the e-mail. A password sent for a
 *    passkey-only account is answered with 400 `passkeyRequired` (only after
 *    the password was proven), which starts the same ceremony.
 *
 * Backup-code recovery is a separate edition stage opened from a "Lost your
 * passkey?" link. OAuth buttons, the ban notice and the links under the form
 * are edition slots too — the self-hosted edition renders none of them.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { OAuthButtons, BanNotice, EmailStageLinks, passkey, EmailNotVerifiedAction, verifiedDestination } = edition.login;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(getRememberMe);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [ban, setBan] = useState<BanInfo | null>(null);
  /** The last sign-in was refused because the address is not confirmed yet. */
  const [unverified, setUnverified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage>('email');
  const [passkeyChallenge, setPasskeyChallenge] = useState<PasskeyChallenge | null>(null);
  // Shared rate-limit countdown. Every login limiter (per-IP and per-email,
  // across begin/password/passkey/backup) feeds the SAME ticking message so
  // the wait time never differs by which bucket tripped — that uniformity is
  // what keeps it from leaking whether an account exists.
  const { remaining: rlRemaining, active: rlActive, start: rlStart } = useCountdown();
  // [WEB-AUTH-009] The running countdown comes from a 423 (the account is
  // locked for this address) rather than a 429: same ticker, its own wording.
  const [lockCountdown, setLockCountdown] = useState(false);
  useEffect(() => { if (!rlActive) setLockCountdown(false); }, [rlActive]);

  // Pick up ?verified=1|0 from the VerifyEmailPage redirect.
  useEffect(() => {
    const verified = searchParams.get('verified');
    // ready=1: the account is already active, so there is no approval to wait for.
    if (verified === '1') setInfo(t(searchParams.get('ready') === '1' ? 'login.verifiedReady' : 'login.verifiedSuccess'));
    else if (verified === '0') setError(t('login.verifiedFailure'));
    if (verified !== null) {
      // The edition may name where to go once signed in (RequireAnonymous
      // follows `state.from` after the sign-in) — e.g. the plan to pay for.
      const dest = verified === '1' ? verifiedDestination?.(searchParams) ?? null : null;
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('verified');
        next.delete('ready');
        next.delete('plan');
        return next;
      }, { replace: true, state: dest ? { from: dest } : undefined });
    }
  }, [t, searchParams, setSearchParams, verifiedDestination]);

  const handleBanError = (err: ApiError) => {
    const body = err.body as { until?: string | null; reason?: string | null; indefinite?: boolean } | undefined;
    setBan({
      until: body?.until ?? null,
      reason: body?.reason ?? null,
      indefinite: !!body?.indefinite,
    });
  };

  /** Run the passkey ceremony: fetch a challenge for the typed e-mail and show the passkey stage. */
  const startPasskey = async (known?: PasskeyChallenge | null) => {
    if (!passkey) return;
    setError('');
    setBan(null);
    setLoading(true);
    try {
      const challenge = known ?? await passkey.start();
      setPasskeyChallenge(challenge);
      setStage('passkey');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        if (err.retryAfter) rlStart(err.retryAfter);
        setError(t('login.rateLimited'));
      } else {
        setError(t('login.passkeyFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBan(null);
    const normalized = email.trim().toLowerCase();
    setEmail(normalized);
    setStage('credentials');
    // This device signed this address in with a passkey last time: offer the
    // prompt at once, as the old pre-flight did — decided locally, not by the server.
    if (passkey && await hasPasskeyHint(normalized)) {
      setLoading(true);
      try {
        const challenge = await passkey.start();
        setPasskeyChallenge(challenge);
        setStage('passkey');
      } catch {
        // Stay on the credentials step; the button is still there.
      } finally {
        setLoading(false);
      }
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBan(null);
    setUnverified(false);
    setLoading(true);
    try {
      const result = await api.login(email, password);
      login(result.token, result.refreshToken, result.user, rememberMe);
      void setPasskeyHint(email, false);
      track('login', { method: 'password' });
    } catch (err) {
      // A passkey-only account answers 400 passkeyRequired after a right
      // password: that is the next step, not a refusal.
      if (!(err instanceof ApiError && (err.body as { passkeyRequired?: boolean } | undefined)?.passkeyRequired)) {
        track('login_error', { code: analyticsErrorCode(err) });
      }
      if (err instanceof ApiError && err.status === 423) {
        if (err.retryAfter) {
          if (!rlActive || err.retryAfter >= rlRemaining) setLockCountdown(true);
          rlStart(err.retryAfter);
        }
        setError(t('login.locked'));
      }
      else if (err instanceof ApiError && err.status === 429) {
        if (err.retryAfter) {
          if (!rlActive || err.retryAfter > rlRemaining) setLockCountdown(false);
          rlStart(err.retryAfter);
        }
        setError(t('login.rateLimited'));
      }
      else if (err instanceof ApiError && err.status === 403 && err.body?.banned) handleBanError(err);
      else if (err instanceof ApiError && err.status === 403 && err.body?.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      else if (err instanceof ApiError && err.status === 400 && (err.body as { passkeyRequired?: boolean })?.passkeyRequired) {
        // A passkey-only account (the password was right): do not bounce to
        // the e-mail step — start the ceremony with the challenge the server
        // sent along, or ask for one.
        setPassword('');
        if (passkey) {
          setLoading(false);
          await startPasskey(passkey.fromPasskeyRequired(err.body));
          setInfo(t('passkey.login.accountNote'));
          return;
        }
        setStage('email');
        setError(t('login.passkeyRequired'));
      } else if (err instanceof ApiError && err.status === 403) setError(t('login.inactive'));
      else setError(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  const restart = () => {
    setStage('email');
    setError('');
    setBan(null);
    setUnverified(false);
    setPasskeyChallenge(null);
    setPassword('');
  };

  const handleOAuthResult = useCallback((result: OAuthResult) => {
    if (result.token && result.refreshToken && result.user) {
      login(result.token, result.refreshToken, result.user, rememberMe);
    } else if (result.pendingActivation) {
      setInfo(t('login.pendingActivation'));
    }
  }, [login, rememberMe, t]);

  const [oauthConsenting, setOauthConsenting] = useState(false);

  const rateLimitWait = rlActive
    ? t(lockCountdown ? 'login.lockedWait' : 'login.rateLimitedWait', { time: formatDuration(rlRemaining) })
    : '';
  const displayError = rateLimitWait || error;

  if (stage === 'backup' && passkey) {
    return (
      <div className="auth-page">
        <passkey.BackupStage email={email} rememberMe={rememberMe} onCancel={restart} />
        <VersionFooter />
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={stage === 'email' ? submitEmail : submitPassword}>
        <img src="/logo.svg" alt="" className="auth-logo" />
        <h1><Wordmark text={t('login.title')} /></h1>
        {ban && BanNotice && <BanNotice until={ban.until} reason={ban.reason} indefinite={ban.indefinite} />}
        {info && <div className="info" style={{ color: 'var(--accent, #6EE7B7)', marginBottom: '8px', textAlign: 'center' }}>{info}</div>}
        {displayError && <div className="error">{displayError}</div>}
        {unverified && !displayError && (
          <div className="info" role="status" data-testid="login-email-not-verified" style={{ marginBottom: '8px', textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px' }}>{t('login.emailNotVerified')}</p>
            {EmailNotVerifiedAction && <EmailNotVerifiedAction email={email} />}
          </div>
        )}

        {stage === 'email' && (
          <>
            {!oauthConsenting && (
              <>
                <input
                  type="email"
                  placeholder={t('login.email')}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoFocus
                  autoComplete="email username webauthn"
                  inputMode="email"
                />
                <label className="remember-me">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} />
                  {t('login.rememberMe')}
                </label>
                <button type="submit" disabled={loading || !email.trim()}>
                  {t('login.continue')}
                </button>
              </>
            )}
            {OAuthButtons && <OAuthButtons onResult={handleOAuthResult} onConsentChange={setOauthConsenting} />}
          </>
        )}

        {stage === 'credentials' && (
          <>
            <p className="settings-hint" style={{ textAlign: 'center', margin: '0 0 6px' }}>{email}</p>
            <input
              type="password"
              placeholder={t('login.password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
            <button type="submit" disabled={loading}>
              {t('login.submit')}
            </button>
            {passkey && (
              <>
                <div className="auth-divider">{t('passkey.login.or')}</div>
                <button type="button" style={{ background: 'transparent', color: 'var(--text)' }} onClick={() => startPasskey()} disabled={loading} data-testid="login-use-passkey">
                  {t('passkey.login.use')}
                </button>
              </>
            )}
            <button type="button" onClick={restart} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #888)', fontSize: '13px', marginTop: '4px', textDecoration: 'underline' }}>
              {t('login.backToEmail')}
            </button>
          </>
        )}

        {stage === 'passkey' && passkey && passkeyChallenge && (
          <passkey.Stage
            email={email}
            challenge={passkeyChallenge}
            onSuccess={(result) => { void setPasskeyHint(email, true); login(result.token, result.refreshToken, result.user, rememberMe); track('login', { method: 'passkey' }); }}
            onError={setError}
            onRateLimit={rlStart}
            onBan={setBan}
            onEmailNotVerified={() => setUnverified(true)}
            onUseBackup={() => setStage('backup')}
            onBack={() => { setStage('credentials'); setError(''); setBan(null); setPasskeyChallenge(null); }}
          />
        )}

        {stage === 'email' && !oauthConsenting && EmailStageLinks && <EmailStageLinks />}
      </form>
      <VersionFooter />
    </div>
  );
}
