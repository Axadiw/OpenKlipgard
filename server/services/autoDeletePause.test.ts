import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { story } from '../testing/story.js';

const { mockIsAccessLocked } = vi.hoisted(() => ({ mockIsAccessLocked: vi.fn() }));

vi.mock('../db/queries/access.js', () => ({
  isAccessLocked: (...a: unknown[]) => mockIsAccessLocked(...a),
}));

import { installEditionHooks } from '../hooks.js';
import { autoDeletePaused } from './autoDeletePause.js';

const USER_ID = 7;

describe('autoDeletePaused', () => {
  beforeEach(() => {
    mockIsAccessLocked.mockReset();
    installEditionHooks(undefined);
  });
  afterEach(() => installEditionHooks(undefined));

  it('API-CORE-050: a locked account is paused', async (ctx) => {
    story(ctx, 'Konto zablokowane (bez planu albo blokada admina) nie traci nagrań przez auto-usuwanie, nawet gdy użytkownik ustawił retencję lub "usuń najstarsze".');
    mockIsAccessLocked.mockResolvedValue(true);

    expect(await autoDeletePaused(USER_ID)).toBe(true);
    expect(mockIsAccessLocked).toHaveBeenCalledWith(USER_ID);
  });

  it('API-CORE-050: with no edition hook an unlocked account is not paused', async (ctx) => {
    story(ctx, 'Edycja self-hosted nie instaluje hooka i nic nie ustawia blokad: auto-usuwanie działa jak dotąd. Ten test chroni OpenKlipgard przed przypadkowym zamrożeniem usuwania.');
    mockIsAccessLocked.mockResolvedValue(false);

    expect(await autoDeletePaused(USER_ID)).toBe(false);
  });

  it('API-CORE-050 [Cloud]: an unlocked account the edition calls suspended is paused', async (ctx) => {
    story(ctx, 'Konto z banem ręcznym nie ma blokady dostępu, ale edycja zgłasza je jako zawieszone przez hook: auto-usuwanie je omija. Hook dostaje id właściwego konta.');
    const accountSuspended = vi.fn().mockResolvedValue(true);
    installEditionHooks({ accountSuspended });
    mockIsAccessLocked.mockResolvedValue(false);

    expect(await autoDeletePaused(USER_ID)).toBe(true);
    expect(accountSuspended).toHaveBeenCalledWith(USER_ID);
  });

  it('API-CORE-050 [Cloud]: an unlocked account the edition does not call suspended is not paused', async (ctx) => {
    story(ctx, 'Zwykłe konto zostaje poza pauzą także wtedy, gdy hook jest zainstalowany: auto-usuwanie zwykłych użytkowników działa bez zmian.');
    installEditionHooks({ accountSuspended: vi.fn().mockResolvedValue(false) });
    mockIsAccessLocked.mockResolvedValue(false);

    expect(await autoDeletePaused(USER_ID)).toBe(false);
  });

  it('API-CORE-118: a failed lock check rejects instead of answering "not paused"', async (ctx) => {
    story(ctx, 'Awaria bazy przy sprawdzaniu blokady nie może oznaczać "nie zablokowane": sprawdzenie rzuca błąd, więc wywołujący niczego nie skasuje.');
    mockIsAccessLocked.mockRejectedValue(new Error('db down'));

    await expect(autoDeletePaused(USER_ID)).rejects.toThrow('db down');
  });

  it('API-CORE-118: a failed edition check rejects instead of answering "not paused"', async (ctx) => {
    story(ctx, 'Awaria odczytu zawieszenia (np. tabeli banów) też nie otwiera drogi do kasowania: błąd przechodzi wyżej.');
    mockIsAccessLocked.mockResolvedValue(false);
    installEditionHooks({ accountSuspended: vi.fn().mockRejectedValue(new Error('ban lookup failed')) });

    await expect(autoDeletePaused(USER_ID)).rejects.toThrow('ban lookup failed');
  });
});
