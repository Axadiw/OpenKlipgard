import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KlipgardLoader, CORNER_PATH, CORNER_PATH_SMALL, K_PATH } from './KlipgardLoader';
import { story } from '../test-story';

describe('KlipgardLoader (WEB-SHELL-079, CLIENT-086)', () => {
  it('draws four corners and the K at 24 px and larger, with role status and the default label', (ctx) => {
    story(ctx, 'Wskaźnik ładowania to znak Klipgard: cztery narożniki i K, z etykietą „Loading” dla czytników ekranu.');
    render(<KlipgardLoader />);
    const svg = screen.getByRole('status');
    expect(svg.getAttribute('aria-label')).toBe('loader.label');
    expect(svg.getAttribute('width')).toBe('28');
    const corners = svg.querySelectorAll('.kg-loader-c path');
    expect(corners).toHaveLength(4);
    corners.forEach(p => expect(p.getAttribute('d')).toBe(CORNER_PATH));
    expect(svg.querySelector('.kg-loader-k')?.getAttribute('d')).toBe(K_PATH);
  });

  it('below 24 px draws thick corners and no K', (ctx) => {
    story(ctx, 'Mały wskaźnik (np. w pasku przetwarzania) ma grubsze narożniki i nie ma K, bo K byłoby nieczytelne.');
    render(<KlipgardLoader size={16} />);
    const svg = screen.getByRole('status');
    expect(svg.hasAttribute('data-small')).toBe(true);
    svg.querySelectorAll('.kg-loader-c path').forEach(p => expect(p.getAttribute('d')).toBe(CORNER_PATH_SMALL));
    expect(svg.querySelector('.kg-loader-k')).toBeNull();
  });

  it('never renders smaller than 12 px', () => {
    render(<KlipgardLoader size={6} />);
    expect(screen.getByRole('status').getAttribute('width')).toBe('12');
  });

  it('cornersOnly drops the K at a large size', () => {
    render(<KlipgardLoader size={30} cornersOnly />);
    const svg = screen.getByRole('status');
    expect(svg.querySelector('.kg-loader-k')).toBeNull();
    svg.querySelectorAll('.kg-loader-c path').forEach(p => expect(p.getAttribute('d')).toBe(CORNER_PATH));
  });

  it('a decorative loader is hidden from assistive tech; a custom label wins over the default', () => {
    const { container, rerender } = render(<KlipgardLoader decorative />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    rerender(<KlipgardLoader label="Loading recordings" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading recordings');
  });

  it('orders the corners clockwise from the top left', () => {
    const { container } = render(<KlipgardLoader />);
    const tr = [...container.querySelectorAll('.kg-loader-c path')].map(p => p.getAttribute('transform'));
    expect(tr).toEqual([
      'translate(146 146)',
      'translate(878 146) scale(-1 1)',
      'translate(878 878) scale(-1 -1)',
      'translate(146 878) scale(1 -1)',
    ]);
  });

  it('tone classes select dark-surface colours (video) and currentColor (filled controls)', () => {
    const { container, rerender } = render(<KlipgardLoader tone="dark" />);
    expect(container.querySelector('svg')!.classList.contains('kg-loader--dark')).toBe(true);
    rerender(<KlipgardLoader tone="content" />);
    expect(container.querySelector('svg')!.classList.contains('kg-loader--content')).toBe(true);
  });
});
