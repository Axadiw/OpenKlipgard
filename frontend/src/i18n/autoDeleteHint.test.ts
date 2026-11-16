import { describe, it, expect } from 'vitest';
import { en } from './en';
import { pl } from './pl';
import { de } from './de';
import { fr } from './fr';
import { it as itCatalog } from './it';
import { es } from './es';
import { no } from './no';
import { tlh } from './tlh';
import { selfhostTranslations } from '../editions/selfhostTranslations';
import { story } from '../test-story';

const catalogs = { en, pl, de, fr, it: itCatalog, es, no, tlh };

describe('WEB-SET-STORAGE-040 auto-delete hint', () => {
  it('WEB-SET-STORAGE-040: no catalog names a 95 % threshold, because eviction starts above the limit', (ctx) => {
    story(ctx, 'Podpowiedź pod przełącznikiem auto-usuwania nie obiecuje bufora 95%: ewikcja zaczyna się dopiero po przekroczeniu limitu.');
    for (const [lang, catalog] of Object.entries(catalogs)) {
      const hint = catalog['settings.autoDeleteHint'];
      expect(hint, lang).toBeTruthy();
      expect(hint, lang).not.toMatch(/95/);
    }
    for (const [lang, catalog] of Object.entries(selfhostTranslations)) {
      const hint = catalog?.['settings.autoDeleteHint'];
      if (hint) expect(hint, `selfhost ${lang}`).not.toMatch(/95/);
    }
  });
});
