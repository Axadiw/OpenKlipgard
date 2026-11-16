import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Wordmark } from './Wordmark';

describe('Wordmark', () => {
  it('[WEB-SHELL-068] tints only the closing "gard" and keeps the title as the text', () => {
    for (const [title, head] of [['Klipgard', 'Klip'], ['OpenKlipgard', 'OpenKlip']]) {
      const { container, unmount } = render(<h1><Wordmark text={title} /></h1>);
      expect(container.querySelector('h1')!.textContent).toBe(title);
      const tinted = container.querySelectorAll('.wordmark-accent');
      expect(tinted).toHaveLength(1);
      expect(tinted[0].textContent).toBe('gard');
      expect(container.querySelector('h1')!.firstChild!.textContent).toBe(head);
      unmount();
    }
  });

  it('[WEB-SHELL-068] renders any other title plain', () => {
    for (const title of ['My cameras', 'gard', 'Klipgard Staging', 'Safe guard']) {
      const { container, unmount } = render(<h1><Wordmark text={title} /></h1>);
      expect(container.querySelector('.wordmark-accent')).toBeNull();
      expect(container.querySelector('h1')!.textContent).toBe(title);
      unmount();
    }
  });
});
