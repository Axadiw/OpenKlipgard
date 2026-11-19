import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KlipgardLogo, LOGO_NAME } from './KlipgardLogo';
import { LOGO_ASPECT, LOGO_PATHS } from './klipgardLogoPaths';

describe('KlipgardLogo', () => {
  it('[WEB-SHELL-068] is one image named "Klipgard", drawn from the brand outlines, never text', () => {
    const { container } = render(<KlipgardLogo height={48} />);
    const svg = screen.getByRole('img', { name: LOGO_NAME });
    expect(LOGO_NAME).toBe('Klipgard');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(container.textContent).toBe('');
    expect(svg.querySelectorAll('.kl-frame')).toHaveLength(LOGO_PATHS.frame.length);
    expect(svg.querySelectorAll('.kl-k')).toHaveLength(LOGO_PATHS.k.length);
    expect(svg.querySelectorAll('.kl-lip')).toHaveLength(LOGO_PATHS.lip.length);
    expect(svg.querySelectorAll('.kl-gard')).toHaveLength(LOGO_PATHS.gard.length);
  });

  it('[WEB-SHELL-068] takes the height and keeps the aspect ratio of the logo', () => {
    render(<KlipgardLogo height={28} className="x" />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('height', '28');
    expect(Number(svg.getAttribute('width'))).toBeCloseTo(28 * LOGO_ASPECT, 1);
    expect(svg).toHaveClass('klipgard-logo', 'x');
  });

  it('[WEB-SHELL-068] puts each corner in a group that holds its placement, so a CSS transform cannot replace it', () => {
    render(<KlipgardLogo height={28} />);
    for (const corner of screen.getByRole('img').querySelectorAll('.kl-frame')) {
      expect(corner.getAttribute('transform')).toBeNull();
      expect(corner.parentElement!.tagName.toLowerCase()).toBe('g');
    }
  });
});
