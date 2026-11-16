import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from '../../i18n';
import { MAX_PATTERN, tokenize } from '../../lib/cameraPattern';

const CHIPS: { name: 'camera' | 'view' | 'ts' | 'ext'; body: string }[] = [
  { name: 'camera', body: '[A-Za-z0-9]+' },
  { name: 'view', body: '\\d{2}' },
  { name: 'ts', body: '\\d{14}' },
  { name: 'ext', body: 'mp4' },
];

interface Props {
  id: string;
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
  describedBy: string;
}

/**
 * Pattern input with syntax colouring (WEB-SET-CAMERAS-071..074).
 *
 * The coloured copy (`<pre aria-hidden>`) is in normal flow and sizes the
 * field. The real `<textarea>` lies over it with transparent text, so it
 * stays the only accessible control and its caret and selection are native.
 */
export function PatternField({ id, value, onChange, invalid, describedBy }: Props) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const tokens = useMemo(() => tokenize(value), [value]);

  useLayoutEffect(() => {
    if (caret.current !== null && taRef.current) {
      taRef.current.focus();
      taRef.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const insert = (name: string, body: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? start;
    const snippet = `(?<${name}>${body})`;
    const next = value.slice(0, start) + snippet + value.slice(end);
    if (next.length > MAX_PATTERN) return;
    caret.current = start + snippet.length;
    onChange(next);
  };

  return (
    <div>
      <div className="cp-patlabel">
        <label htmlFor={id}>{t('settings.cameraProfiles.profileRegex')}</label>
        <span className="cp-count" data-over={value.length >= MAX_PATTERN}>
          {value.length}/{MAX_PATTERN}
        </span>
      </div>
      <div className={`cp-pat${invalid ? ' has-err' : ''}`}>
        <pre className="cp-hl" aria-hidden="true" data-testid="pattern-overlay">
          {tokens.map((tk, i) => (
            <span key={i} className={`cp-t ${tk.cls}`}>{tk.text}</span>
          ))}
          {'\n'}
        </pre>
        <textarea
          id={id}
          ref={taRef}
          className="cp-ta"
          value={value}
          rows={2}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={MAX_PATTERN}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}
          data-testid="profile-regex-input"
        />
      </div>
      <div className="cp-chips" role="group" aria-label={t('settings.cameraProfiles.pg.insertGroup')}>
        <span className="cp-hint">{t('settings.cameraProfiles.pg.insertGroup')}</span>
        {CHIPS.map(c => (
          <button
            key={c.name}
            type="button"
            className={`cp-chip g-${c.name}`}
            onClick={() => insert(c.name, c.body)}
            data-testid={`insert-group-${c.name}`}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
