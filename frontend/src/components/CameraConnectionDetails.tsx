import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { edition } from '../edition';
import { useServerConfig } from '../hooks/useServerConfig';
import { useTranslation } from '../i18n';
import { copyText } from '../utils/clipboard';

const COPIED_MS = 1500;
const T = 'events.emptyFirstTime.connect.';

/**
 * What to enter in a camera's FTP settings, for an account that has no
 * recordings yet: the server and port the server reports in GET /config, the
 * account e-mail as the user name, and notes on the password, the encryption
 * and passive mode.
 *
 * Renders nothing until /config has loaded, or when the host, the port or the
 * account e-mail is missing (WEB-GRID-098, WEB-SET-CAMERAS-062).
 *
 * Which password a camera needs is a fact about the account, not about the
 * server: an account with a passkey can have a separate FTP password. The core
 * cannot tell, so it does not guess. The edition's `cameraConnect` slot gives
 * the value of the Password row and a footer; without it the row names the
 * account password.
 */
export function CameraConnectionDetails() {
  const { t } = useTranslation();
  const config = useServerConfig();
  const { user } = useAuth();
  const headingId = useId();

  if (!config || !config.ftps.host || !Number.isFinite(config.ftps.port) || !user?.email) {
    return null;
  }
  const { host, port } = config.ftps;
  const { PasswordValue, Footer } = edition.cameraConnect ?? {};

  return (
    <section className="camera-connect" data-testid="camera-connect" aria-labelledby={headingId}>
      <h3 id={headingId} className="camera-connect-title">{t(`${T}title`)}</h3>
      <dl className="camera-connect-list">
        <Row label={t(`${T}server`)} value={host} mono copy />
        <Row label={t(`${T}port`)} value={String(port)} mono copy />
        <Row label={t(`${T}username`)} value={user.email} mono copy />
        <Row label={t(`${T}password`)} value={t(`${T}passwordValue`)}>
          {PasswordValue && <PasswordValue />}
        </Row>
        <Row label={t(`${T}encryption`)} value={t(`${T}encryptionValue`)} />
      </dl>
      <p className="camera-connect-hint">{t(`${T}passiveHint`, { host })}</p>
      {Footer && <Footer />}
    </section>
  );
}

/**
 * One label and one value. When there are `children`, they show in place of
 * `value`; a Copy button still copies `value`.
 */
function Row({ label, value, mono = false, copy = false, children }: { label: string; value: string; mono?: boolean; copy?: boolean; children?: ReactNode }) {
  return (
    <div className="camera-connect-row">
      <dt>{label}</dt>
      <dd>
        <span className={mono ? 'camera-connect-value camera-connect-mono' : 'camera-connect-value'}>{children ?? value}</span>
        {copy && <CopyButton value={value} label={label} />}
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    // Only confirm a copy that really happened.
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <>
      <button type="button" className="btn btn-sm camera-connect-copy" onClick={copy} aria-label={`${t(`${T}copy`)}: ${label}`}>
        {t(copied ? `${T}copied` : `${T}copy`)}
      </button>
      <span className="camera-connect-status" role="status">{copied ? t(`${T}copied`) : ''}</span>
    </>
  );
}
