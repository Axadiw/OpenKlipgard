import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';
import type { CameraEvent } from '../types.js';
import type { FileMetaRow } from '../db/queries/events.js';

// --- Hoisted mocks ---
const {
  mockGetAutoDeleteOldest,
  mockGetOldestFileForUser,
  mockGetUserFileCount,
  mockFindEventsReferencingS3Key,
  mockUpdateEventFiles,
  mockUpdateDiskUsage,
  mockRemoveFileMetadata,
  mockDeleteFileMetadataReturningSize,
  mockDeleteObject,
  mockDeleteEventAndThumbnail,
  mockGetFileMetadataByKey,
  mockDeleteObjectsByPrefix,
} = vi.hoisted(() => ({
  mockGetAutoDeleteOldest: vi.fn(),
  mockGetOldestFileForUser: vi.fn(),
  mockGetUserFileCount: vi.fn(),
  mockFindEventsReferencingS3Key: vi.fn(),
  mockUpdateEventFiles: vi.fn(),
  mockUpdateDiskUsage: vi.fn(),
  mockRemoveFileMetadata: vi.fn(),
  mockDeleteFileMetadataReturningSize: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockDeleteEventAndThumbnail: vi.fn(),
  mockGetFileMetadataByKey: vi.fn(),
  mockDeleteObjectsByPrefix: vi.fn(),
}));

vi.mock('../db/queries/events.js', () => ({
  getOldestFileForUser: (...args: unknown[]) => mockGetOldestFileForUser(...args),
  getUserFileCount: (...args: unknown[]) => mockGetUserFileCount(...args),
  findEventsReferencingS3Key: (...args: unknown[]) => mockFindEventsReferencingS3Key(...args),
  updateEventFiles: (...args: unknown[]) => mockUpdateEventFiles(...args),
  removeFileMetadata: (...args: unknown[]) => mockRemoveFileMetadata(...args),
  deleteFileMetadataReturningSize: (...args: unknown[]) => mockDeleteFileMetadataReturningSize(...args),
  getFileMetadataByKey: (...args: unknown[]) => mockGetFileMetadataByKey(...args),
}));

vi.mock('../db/queries/storage.js', () => ({
  getAutoDeleteOldest: (...args: unknown[]) => mockGetAutoDeleteOldest(...args),
  updateDiskUsage: (...args: unknown[]) => mockUpdateDiskUsage(...args),
}));

vi.mock('./s3.js', () => ({
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  deleteObjectsByPrefix: (...args: unknown[]) => mockDeleteObjectsByPrefix(...args),
}));

vi.mock('./eventCleanup.js', () => ({
  deleteEventAndThumbnail: (...args: unknown[]) => mockDeleteEventAndThumbnail(...args),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    s3RecordingsBucket: 'klipgard-recordings',
    s3ThumbnailsBucket: 'klipgard-thumbnails',
    s3SidecarsBucket: 'klipgard-sidecars',
  },
}));

import { autoDeleteOldestUntilFreed, evictFile, deleteUserVideoObject } from './autoDelete.js';

const USER_ID = 42;
const USER_UUID = 'aaaa1111-2222-3333-4444-bbbbbbbbbbbb';

function makeFile(overrides: Partial<FileMetaRow> = {}): FileMetaRow {
  return {
    id: 1,
    ownerId: USER_ID,
    s3Bucket: 'klipgard-recordings',
    s3Key: `${USER_UUID}/Cam01/2026-01-01/clip-old.mp4`,
    originalFilename: 'clip-old.mp4',
    fileSizeBytes: 10_000_000,
    uploadedAt: '2026-01-01T00:00:00.000Z',

    ...overrides,
  };
}

function makeEvent(overrides: Partial<CameraEvent> = {}): CameraEvent {
  return {
    id: 'evt-1',
    camera: 'Cam01',
    timestamp: '2026-01-01T00:00:00Z',
    date: '2026-01-01',
    views: [{ id: '00', videoRelPath: 'Cam01/2026-01-01/clip-old.mp4' }],
    thumbnail: null,
    ownerId: USER_ID,
    ...overrides,
  };
}

describe('autoDelete — file-FIFO + cascade', () => {
  beforeEach(() => {
    // resetAllMocks clears queued `mockResolvedValueOnce` overrides AND call
    // history; clearAllMocks would only do the latter and would leak Once
    // values across tests, breaking the cap-test which depends on the
    // default `getUserFileCount` returning the per-test override.
    vi.resetAllMocks();
    mockGetAutoDeleteOldest.mockResolvedValue(true);
    mockGetUserFileCount.mockResolvedValue(100);
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteObjectsByPrefix.mockResolvedValue(0);
    mockGetFileMetadataByKey.mockResolvedValue(null);
    mockUpdateEventFiles.mockResolvedValue(undefined);
    mockUpdateDiskUsage.mockResolvedValue(undefined);
    mockRemoveFileMetadata.mockResolvedValue(undefined);
    mockDeleteFileMetadataReturningSize.mockResolvedValue({ deleted: true, fileSizeBytes: 10_000_000 });
    mockDeleteEventAndThumbnail.mockResolvedValue(undefined);
    mockFindEventsReferencingS3Key.mockResolvedValue([]);
    mockGetOldestFileForUser.mockResolvedValue(null);
  });

  describe('evictFile cascade', () => {
    it('nulls only the matching event column when other media survives', async (ctx) => {
      story(ctx, 'Plik wide_video kasujemy, ale event ma jeszcze zoom_video — wpis pozostaje, kolumna wide_video idzie na NULL. Reconciler i UI dalej widzą event z dostępnym zoom-em.');
      const file = makeFile();
      const event = makeEvent({
        views: [
          { id: '00', videoRelPath: 'Cam01/2026-01-01/clip-old.mp4' },
          { id: '01', videoRelPath: 'Cam01/2026-01-01/clip-old-zoom.mp4' },
        ],
      });
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([event]);

      const freed = await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(freed).toBe(file.fileSizeBytes);
      expect(mockDeleteObject).toHaveBeenCalledWith(file.s3Bucket, file.s3Key);
      // updateEventFiles is called with the rel_path being evicted; the DB
      // helper drops the matching event_view_files row and nulls thumbnail
      // if it pointed at the same path.
      expect(mockUpdateEventFiles).toHaveBeenCalledWith(event.id, USER_ID, 'Cam01/2026-01-01/clip-old.mp4');
      expect(mockDeleteEventAndThumbnail).not.toHaveBeenCalled();
      expect(mockDeleteFileMetadataReturningSize).toHaveBeenCalledWith(USER_ID, file.s3Bucket, file.s3Key);
      expect(mockUpdateDiskUsage).toHaveBeenCalledWith(USER_ID, -file.fileSizeBytes);
    });

    it('deletes the event row + generated thumbnail when no media survives', async (ctx) => {
      story(ctx, 'Po skasowaniu ostatniego wide_video event traci sens — wywalamy wiersz oraz wygenerowaną miniaturkę z bucketa thumbs, żeby nie zostały sieroty po cascade-eviction.');
      const file = makeFile();
      const event = makeEvent({ thumbnail: null });
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([event]);

      const freed = await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(freed).toBe(file.fileSizeBytes);
      // The eviction reason is forwarded, not defaulted: `quota` (user out of
      // space) and `retention` (their own age rule) are different things on the
      // activity dashboard, and both policies share this one function.
      expect(mockDeleteEventAndThumbnail).toHaveBeenCalledWith(event.id, USER_ID, USER_UUID, 'quota');
      expect(mockUpdateEventFiles).not.toHaveBeenCalled();
    });

    it('handles files not referenced by any event (junk uploads, malformed names)', async (ctx) => {
      story(ctx, 'Plik nie podpięty do żadnego eventu (np. śmieciowy upload albo zły naming) jest nadal w FIFO i powinien wylecieć — to było główne zastrzeżenie usera, że stara logika eventu by takich nie ruszała.');
      const file = makeFile({ s3Key: `${USER_UUID}/random-junk.txt` });
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([]);

      const freed = await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(freed).toBe(file.fileSizeBytes);
      expect(mockDeleteObject).toHaveBeenCalledWith(file.s3Bucket, file.s3Key);
      expect(mockUpdateEventFiles).not.toHaveBeenCalled();
      expect(mockDeleteEventAndThumbnail).not.toHaveBeenCalled();
      expect(mockDeleteFileMetadataReturningSize).toHaveBeenCalled();
    });

    it('DATA-122: removes every sidecar variant by prefix, not only .fmp4patch', async (ctx) => {
      story(ctx, 'Eviction czyści sidecary tą samą funkcją opartą na prefiksie co ręczne usuwanie nagrania, więc .clean_frame i .frames nie zostają dla orphan sweep.');
      const file = makeFile();
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([]);

      await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(mockDeleteObjectsByPrefix).toHaveBeenCalledTimes(1);
      expect(mockDeleteObjectsByPrefix).toHaveBeenCalledWith('klipgard-sidecars', `${file.s3Key}.`);
      // The old code deleted the single key `${s3Key}.fmp4patch` only.
      expect(mockDeleteObject).not.toHaveBeenCalledWith('klipgard-sidecars', `${file.s3Key}.fmp4patch`);
    });

    it('DATA-122: a failed sidecar delete is best-effort and does not fail the eviction', async (ctx) => {
      story(ctx, 'Sidecar cleanup jest best-effort: błąd listingu sidecarów nie cofa już skasowanego nagrania, orphan sweep dokończy.');
      const file = makeFile();
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([]);
      mockDeleteObjectsByPrefix.mockRejectedValueOnce(new Error('list failed'));

      const freed = await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(freed).toBe(file.fileSizeBytes);
    });

    it('DATA-124: reports an S3 delete failure to the caller; row and counter stay', async (ctx) => {
      story(ctx, 'S3-first eviction: gdy S3 padnie, evictFile rzuca błąd (pętla caller-a przerywa), file_metadata zostaje, disk_usage NIE spada, a sidecary i eventy nie są ruszane.');
      const file = makeFile();
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([makeEvent()]);
      mockDeleteObject.mockRejectedValueOnce(new Error('s3 hiccup'));

      await expect(evictFile(file, USER_ID, USER_UUID, 'quota')).rejects.toThrow('s3 hiccup');

      expect(mockDeleteFileMetadataReturningSize).not.toHaveBeenCalled();
      expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
      expect(mockDeleteObjectsByPrefix).not.toHaveBeenCalled();
      expect(mockDeleteEventAndThumbnail).not.toHaveBeenCalled();
    });

    it('DATA-124: reports a row delete failure to the caller and skips the counter decrement', async (ctx) => {
      story(ctx, 'Gdy delete wiersza wybucha (transient DB error), disk_usage zostaje (brak skew), a caller dostaje błąd zamiast cichego 0.');
      const file = makeFile();
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([]);
      mockDeleteFileMetadataReturningSize.mockRejectedValueOnce(new Error('db transient'));

      await expect(evictFile(file, USER_ID, USER_UUID, 'quota')).rejects.toThrow('db transient');

      expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
    });

    it('DATA-124: treats NoSuchKey as deleted and returns the freed bytes', async (ctx) => {
      story(ctx, 'Obiekt już nieobecny w S3 (NoSuchKey) to sukces: wiersz jest usuwany, bajty zwolnione, brak błędu.');
      const file = makeFile();
      mockFindEventsReferencingS3Key.mockResolvedValueOnce([]);
      const gone = new Error('gone');
      gone.name = 'NoSuchKey';
      mockDeleteObject.mockRejectedValueOnce(gone);

      const freed = await evictFile(file, USER_ID, USER_UUID, 'quota');

      expect(freed).toBe(file.fileSizeBytes);
    });
  });

  describe('autoDeleteOldestUntilFreed loop', () => {
    it('returns enabled=false immediately when the flag is OFF', async (ctx) => {
      story(ctx, 'Bez flagi auto-delete usługa to no-op — gwarantuje, że nie ruszymy danych użytkowników, którzy nie zgodzili się na eviction.');
      mockGetAutoDeleteOldest.mockResolvedValueOnce(false);

      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 1024);

      expect(result).toEqual({ deleted: 0, freedBytes: 0, enabled: false });
      expect(mockGetOldestFileForUser).not.toHaveBeenCalled();
    });

    it('walks oldest-first until the target is met', async (ctx) => {
      story(ctx, 'FIFO chodzi po file_metadata.uploaded_at ASC — pierwsze pliki idą pierwsze. Test sprawdza, że pętla zatrzymuje się gdy uwolniona przestrzeń osiągnie cel.');
      const f1 = makeFile({ id: 1, fileSizeBytes: 30_000_000 });
      const f2 = makeFile({ id: 2, fileSizeBytes: 30_000_000, s3Key: `${USER_UUID}/clip-2.mp4` });
      mockGetOldestFileForUser
        .mockResolvedValueOnce(f1)
        .mockResolvedValueOnce(f2)
        .mockResolvedValueOnce(null);
      mockFindEventsReferencingS3Key.mockResolvedValue([]);

      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 50_000_000);

      expect(result.enabled).toBe(true);
      expect(result.deleted).toBe(2);
      expect(result.freedBytes).toBe(60_000_000);
    });

    it('frees as much as the caller asked for, up to library exhaustion', async (ctx) => {
      story(ctx, 'Po user feedbacku 2026-04-29 capy 50/25% zostały zdjęte — opt-in w `auto_delete_oldest` to consent usera. Pętla terminuje gdy targetBytes osiągnięte ALBO gdy biblioteka pusta. Tu user ma 1000 plików, target wymaga zwolnienia 1000 — wszystkie idą.');
      const tinyFile = makeFile({ fileSizeBytes: 1 });
      // Drain semantics: return tinyFile 1000× then null.
      let returned = 0;
      mockGetOldestFileForUser.mockImplementation(async () => {
        if (returned >= 1000) return null;
        returned++;
        return tinyFile;
      });
      mockFindEventsReferencingS3Key.mockResolvedValue([]);

      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 1000);

      expect(result.deleted).toBe(1000);
      expect(result.freedBytes).toBe(1000);
    });

    it('stops at target — does NOT drain the library when target is met early', async (ctx) => {
      story(ctx, 'Naturalna terminacja: gdy `freedBytes >= targetBytes`, pętla się zatrzymuje. Mały plik na pełnym koncie nie pociąga za sobą full drain.');
      const fatFile = makeFile({ fileSizeBytes: 1_000_000 });
      mockGetOldestFileForUser.mockResolvedValue(fatFile);
      mockFindEventsReferencingS3Key.mockResolvedValue([]);

      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 500_000);

      expect(result.deleted).toBe(1);   // single file freed 1 MB, target 500 KB met
      expect(result.freedBytes).toBe(1_000_000);
    });

    it('exits cleanly when the library is empty', async (ctx) => {
      story(ctx, 'Pusta biblioteka = enabled:true, deleted:0, freedBytes:0 — caller (claim-or-evict) zwróci 507 do FTPS, plik z S3 zostanie skasowany, kamera dostanie 552.');
      mockGetOldestFileForUser.mockResolvedValue(null);

      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 100);

      expect(result).toEqual({ deleted: 0, freedBytes: 0, enabled: true });
    });

    it('does not create any notification (silent eviction — Phase D)', async (ctx) => {
      story(ctx, 'Zgodnie z wymaganiami: brak notyfikacji o auto-deleted_oldest. Notification feed nie ma być spamowany rutynową ewikcją.');
      const f1 = makeFile({ fileSizeBytes: 1_000_000 });
      mockGetOldestFileForUser.mockResolvedValueOnce(f1).mockResolvedValueOnce(null);
      mockFindEventsReferencingS3Key.mockResolvedValue([]);

      // The createNotification mock is intentionally NOT registered — if the
      // service tries to call it, the unmocked module would blow up. The fact
      // that the test passes proves there's no call.
      const result = await autoDeleteOldestUntilFreed(USER_ID, USER_UUID, 'salt', 500_000);

      expect(result.deleted).toBe(1);
    });
  });

  describe('deleteUserVideoObject dispatch', () => {
    it('routes to deleteObject(recordings)', async (ctx) => {
      story(ctx, 'Mp4 są kasowane z bucketa recordings; sidecar (jeśli istnieje) leci osobno z sidecars bucketa.');
      await deleteUserVideoObject({
        userUuid: USER_UUID,
        s3Bucket: 'klipgard-recordings',
        s3Key: `${USER_UUID}/Cam01/clip.mp4`,
    
      });
      expect(mockDeleteObject).toHaveBeenCalledWith('klipgard-recordings', `${USER_UUID}/Cam01/clip.mp4`);
    });

  });
});
