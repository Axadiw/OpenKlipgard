import type { CSSProperties } from 'react';
import { useTranslation } from '../i18n';
import './KlipgardLoader.css';

// The Klipgard loader (WEB-SHELL-079, CLIENT-086): the mark of the brand book
// with the breathe motion. Geometry from docs/brand/svg/klipgard-loader*.svg.

/** Corner of the mark, top left, on the 1024 grid. */
export const CORNER_PATH = 'M0 200V82A82 82 0 0 1 82 0H200V54H81A27 27 0 0 0 54 81V200Z';
/** Thick corner for the loader below SMALL_BELOW px. */
export const CORNER_PATH_SMALL = 'M0 260V100A100 100 0 0 1 100 0H260V100H100V260Z';
export const K_PATH =
  'M312 294L416 294L416 495L601 294L727 294L533 505.5L729 730L600 730L416 521L416 730L312 730Z';
/** Clockwise from the top left; the CSS delays are 0, 100, 200 and 300 ms in this order. */
export const CORNER_TRANSFORMS = [
  'translate(146 146)',
  'translate(878 146) scale(-1 1)',
  'translate(878 878) scale(-1 -1)',
  'translate(146 878) scale(1 -1)',
] as const;
/** Below this size the K is not readable: thick corners only. */
export const SMALL_BELOW = 24;
export const MIN_SIZE = 12;

export type LoaderTone = 'brand' | 'white' | 'content';

export interface KlipgardLoaderProps {
  /** Rendered width and height in px. Default 28. */
  size?: number;
  /** brand = theme colours; white = on video; content = currentColor (inside filled controls). */
  tone?: LoaderTone;
  /** Draw the corners only, also at 24 px and larger (for example around the play icon). */
  cornersOnly?: boolean;
  /** Accessible name. Default: `loader.label`. Ignored when `decorative`. */
  label?: string;
  /** A visible text next to the loader says the same: hide it from assistive tech. */
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

export function KlipgardLoader({
  size = 28,
  tone = 'brand',
  cornersOnly = false,
  label,
  decorative = false,
  className,
  style,
  'data-testid': testId,
}: KlipgardLoaderProps) {
  const { t } = useTranslation();
  const px = Math.max(MIN_SIZE, size);
  const small = px < SMALL_BELOW;
  const corner = small ? CORNER_PATH_SMALL : CORNER_PATH;
  const showK = !small && !cornersOnly;
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'status', 'aria-label': label ?? t('loader.label') };
  const cls = ['kg-loader', tone !== 'brand' ? `kg-loader--${tone}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      className={cls}
      viewBox="146 146 732 732"
      width={px}
      height={px}
      style={style}
      focusable="false"
      data-testid={testId ?? 'klipgard-loader'}
      data-small={small ? '' : undefined}
      {...a11y}
    >
      <g className="kg-loader-corners">
        {CORNER_TRANSFORMS.map((tr, i) => (
          <g key={tr} className={`kg-loader-c kg-loader-c${i + 1}`}>
            <path transform={tr} d={corner} />
          </g>
        ))}
      </g>
      {showK && <path className="kg-loader-k" d={K_PATH} />}
    </svg>
  );
}
