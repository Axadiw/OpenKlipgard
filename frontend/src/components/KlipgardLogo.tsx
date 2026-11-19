import { LOGO_ASPECT, LOGO_PATHS, LOGO_VIEWBOX } from './klipgardLogoPaths';

/** The name the logo draws; a catalog title other than this renders as plain text (WEB-SHELL-070). */
export const LOGO_NAME = 'Klipgard';

const [VB_X, VB_Y, , VB_H] = LOGO_VIEWBOX.split(' ').map(Number);
/** Right edge of the frame: the mirrored corners are translated to it. */
const FRAME_RIGHT = Math.max(
  ...LOGO_PATHS.frame.map((p) => Number(/translate\(([-\d.]+)/.exec(p.transform ?? '')?.[1] ?? 0)),
);
/** Width : height of the mark alone (frame + K), the part the header keeps at 720 px and below. */
export const MARK_ASPECT = FRAME_RIGHT / VB_H;
/** Centre of the frame, the origin of the K's scale in the focus motion. */
const FRAME_CENTRE = `${(VB_X + FRAME_RIGHT / 2).toFixed(2)}px ${(VB_Y + VB_H / 2).toFixed(2)}px`;

interface Props {
  /** Height of the frame in px; the width follows the logo's aspect ratio. */
  height: number;
  className?: string;
}

/**
 * The Klipgard logo ("[K]lipgard", WEB-SHELL-068): the outlines from the brand
 * book, never a font. Colours come from CSS (`--brand-video`, `--logo-k`,
 * `--logo-lip`, WEB-SHELL-069), so the logo follows the theme. Each corner of the
 * frame sits in a group that carries its placement, so a CSS transform on the
 * corner itself (the focus motion, WEB-PUBLIC-111) moves it along its own diagonal
 * without replacing that placement.
 */
export function KlipgardLogo({ height, className }: Props) {
  return (
    <svg
      className={`klipgard-logo${className ? ` ${className}` : ''}`}
      viewBox={LOGO_VIEWBOX}
      width={+(height * LOGO_ASPECT).toFixed(2)}
      height={height}
      preserveAspectRatio="xMinYMid slice"
      role="img"
      aria-label={LOGO_NAME}
      focusable="false"
    >
      {LOGO_PATHS.frame.map((p, i) => (
        <g key={i} transform={p.transform}>
          <path className="kl-frame" d={p.d} />
        </g>
      ))}
      {LOGO_PATHS.k.map((p, i) => (
        <g key={i} transform={p.transform}>
          <path className="kl-k" d={p.d} style={{ transformOrigin: FRAME_CENTRE }} />
        </g>
      ))}
      {LOGO_PATHS.lip.map((p, i) => (
        <path key={i} className="kl-lip" d={p.d} transform={p.transform} />
      ))}
      {LOGO_PATHS.gard.map((p, i) => (
        <path key={i} className="kl-gard" d={p.d} transform={p.transform} />
      ))}
    </svg>
  );
}
