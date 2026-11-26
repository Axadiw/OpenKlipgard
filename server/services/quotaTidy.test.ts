import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { story } from '../testing/story.js';
import type { FileMetaRow } from '../db/queries/events.js';

const {
  mockGetUserQuota,
  mockGetDiskUsage,
  mockWithUserAdvisoryLock,
  mockGetOldestFileForUser,
  mockEvictFile,
  mockIsAccessLocked,
} = vi.hoisted(() => ({
  mockGetUserQuota: vi.fn(),
  mockGetDiskUsage: vi.fn(),
  mockWithUserAdvisoryLock: vi.fn(),
  mockGetOldestFileForUser: vi.fn(),
  mockEvictFile: vi.fn(),
  mockIsAccessLocked: vi.fn(),
}));

// The pause check itself stays real (autoDeletePause.ts + the edition hooks);
// only its database read is replaced.
vi.mock('../db/queries/access.js', () => ({
  isAccessLocked: (...a: unknown[]) => mockIsAccessLocked(...a),
}));

vi.mock('../db/queries/storage.js', () => ({
  getUserQuota: (...a: unknown[]) => mockGetUserQuota(...a),
  getDiskUsage: (...a: unknown[]) => mockGetDiskUsage(...a),
  withUserAdvisoryLock: (...a: unknown[]) => mockWithUserAdvisoryLock(...a),
  getUsersOverQuotaWithAutoDelete: vi.fn(),
  getUsersByPlan: vi.fn(),
}));
vi.mock('../db/queries/events.js', () => ({
  getOldestFileForUser: (...a: unknown[]) => mockGetOldestFileForUser(...a),
}));
vi.mock('./autoDelete.js', () => ({
  evictFile: (...a: unknown[]) => mockEvictFile(...a),
}));
vi.mock('./quota-reconciler.js', () => ({ reconcileUserQuota: vi.fn() }));

import { installEditionHooks } from '../hooks.js';
import { evictUserToFitPlan } from './quotaTidy.js';

const USER_ID = 7;
const UUID = 'aaaa1111-2222-3333-4444-bbbbbbbbbbbb';

function file(id: number, size: number): FileMetaRow {
  return {
    id,
    ownerId: USER_ID,
    s3Bucket: 'rec',
    s3Key: `${UUID}/f${id}.mp4`,
    originalFilename: `f${id}.mp4`,
    fileSizeBytes: size,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  } as FileMetaRow;
}

describe('quotaTidy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithUserAdvisoryLock.mockImplementation(async (_id: number, fn: () => Promise<unknown>) => fn());
    mockGetUserQuota.mockResolvedValue({ diskLimitBytes: 1000 });
    mockIsAccessLocked.mockResolvedValue(false);
    installEditionHooks(undefined);
  });
  afterEach(() => installEditionHooks(undefined));

  it('DATA-124: stops on the first eviction that throws and does not spin on the same file', async (ctx) => {
    story(ctx, 'Trwała awaria S3 na najstarszym pliku: pętla ewikcji kończy się po pierwszym błędzie zamiast trzymać blokadę konta przez całą awarię.');
    mockGetDiskUsage.mockResolvedValue(5000);
    mockGetOldestFileForUser.mockResolvedValue(file(1, 100));
    mockEvictFile.mockRejectedValue(new Error('s3 outage'));

    const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

    expect(mockEvictFile).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ deleted: 0, freedBytes: 0, skipped: false });
  });

  it('DATA-124: keeps what earlier evictions freed when a later one throws', async (ctx) => {
    story(ctx, 'Pierwszy plik zwolniony, drugi pada na S3: wynik raportuje 1 usunięty plik i jego bajty, pętla staje.');
    mockGetDiskUsage.mockResolvedValue(5000);
    mockGetOldestFileForUser
      .mockResolvedValueOnce(file(1, 100))
      .mockResolvedValueOnce(file(2, 100));
    mockEvictFile.mockResolvedValueOnce(100).mockRejectedValueOnce(new Error('s3 outage'));

    const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

    expect(mockEvictFile).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ deleted: 1, freedBytes: 100, skipped: false });
  });

  it('DATA-124: evicts the exact minimum and stops once usage is at or under the plan', async (ctx) => {
    story(ctx, 'Bez bufora: po zejściu użycia do limitu pętla przestaje usuwać.');
    mockGetDiskUsage.mockResolvedValueOnce(1100).mockResolvedValueOnce(1000);
    mockGetOldestFileForUser.mockResolvedValue(file(1, 100));
    mockEvictFile.mockResolvedValue(100);

    const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

    expect(mockEvictFile).toHaveBeenCalledTimes(1);
    expect(r.deleted).toBe(1);
  });

  it('DATA-124: returns skipped when the account lock is held', async (ctx) => {
    story(ctx, 'Inny tidy trzyma blokadę konta: wywołanie zwraca skipped i nic nie usuwa.');
    mockWithUserAdvisoryLock.mockResolvedValue(null);

    const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

    expect(r).toEqual({ deleted: 0, freedBytes: 0, skipped: true });
    expect(mockEvictFile).not.toHaveBeenCalled();
  });

  describe('automatic deletion pause [API-CORE-050, API-CORE-118]', () => {
    it('API-CORE-118: evicts nothing for a locked account that is over plan', async (ctx) => {
      story(ctx, 'Konto zablokowane jest ponad planem i ma "usuń najstarsze": tidy je omija, żeby blokada chroniła nagrania. Pętla kończy się bez ruszenia żadnego pliku.');
      mockIsAccessLocked.mockResolvedValue(true);
      mockGetDiskUsage.mockResolvedValue(5000);
      mockGetOldestFileForUser.mockResolvedValueOnce(file(1, 100)).mockResolvedValue(null);

      const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

      expect(mockEvictFile).not.toHaveBeenCalled();
      expect(r).toEqual({ deleted: 0, freedBytes: 0, skipped: false });
    });

    it('API-CORE-118: stops after the first file when the account becomes locked during the run', async (ctx) => {
      story(ctx, 'Blokada pojawia się w trakcie tidy: pętla sprawdza ją przed każdym plikiem, więc po zawieszeniu nie wyleci już żaden kolejny plik.');
      mockIsAccessLocked.mockResolvedValueOnce(false).mockResolvedValue(true);
      mockGetDiskUsage.mockResolvedValue(5000);
      mockGetOldestFileForUser
        .mockResolvedValueOnce(file(1, 100))
        .mockResolvedValueOnce(file(2, 100))
        .mockResolvedValue(null);
      mockEvictFile.mockResolvedValue(100);

      const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

      expect(mockEvictFile).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ deleted: 1, freedBytes: 100, skipped: false });
    });

    it('API-CORE-050 [Cloud]: evicts nothing for an unlocked account the edition calls suspended', async (ctx) => {
      story(ctx, 'Konto z banem ręcznym nie ma blokady dostępu, ale edycja zgłasza je jako zawieszone: tidy go nie rusza. Hook dostaje id właściwego konta.');
      installEditionHooks({ accountSuspended: async (id) => id === USER_ID });
      mockGetDiskUsage.mockResolvedValue(5000);
      mockGetOldestFileForUser.mockResolvedValueOnce(file(1, 100)).mockResolvedValue(null);

      const r = await evictUserToFitPlan(USER_ID, UUID, 'salt');

      expect(mockEvictFile).not.toHaveBeenCalled();
      expect(r).toEqual({ deleted: 0, freedBytes: 0, skipped: false });
    });

    it('API-CORE-118: evicts nothing when the check fails', async (ctx) => {
      story(ctx, 'Awaria bazy przy sprawdzaniu blokady nie otwiera drogi do kasowania: tidy kończy się błędem, żaden plik nie wylatuje.');
      mockIsAccessLocked.mockRejectedValue(new Error('db down'));
      mockGetDiskUsage.mockResolvedValue(5000);
      mockGetOldestFileForUser.mockResolvedValueOnce(file(1, 100)).mockResolvedValue(null);

      await expect(evictUserToFitPlan(USER_ID, UUID, 'salt')).rejects.toThrow('db down');
      expect(mockEvictFile).not.toHaveBeenCalled();
    });
  });
});
