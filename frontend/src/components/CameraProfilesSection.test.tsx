import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CameraProfilesSection } from './CameraProfilesSection';
import { story } from '../test-story';

const apiMocks = vi.hoisted(() => ({
  getCameraProfiles: vi.fn(),
  setCameraProfileMode: vi.fn(),
  createCustomProfile: vi.fn(),
  updateCustomProfile: vi.fn(),
  deleteCustomProfile: vi.fn(),
  resetCameraProfiles: vi.fn(),
}));

// The page runs patterns in a Web Worker; jsdom has none, so run them inline here.
vi.mock('../lib/cameraPatternRunner', async () => {
  const { runJob } = await import('../lib/cameraPattern');
  return { runBatch: async (jobs: Parameters<typeof runJob>[0][]) => ({ kind: 'ok', results: jobs.map(runJob) }) };
});

vi.mock('../api', () => ({
  api: apiMocks,
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const defaultProfile = {
  id: 1,
  name: 'My Camera',
  regex: '^(?<camera>[^_]+)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
  viewDefault: '00' as const,
  viewsConfig: [{ id: '00', iconKind: 'generic' as const }],
  priority: 10,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
};

// The 4 canonical vendor templates the server surfaces in the
// camera-profiles GET response. Custom mode seeds these when the list is empty.
const templates = [
  { name: 'Reolink', regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'wide' as const }, { id: '01', iconKind: 'zoom' as const }] },
  { name: 'Hikvision', regex: '^Webcam_G(?<camera>\\d+)_(?<ts>\\d{14}).*$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
  { name: 'Axis', regex: '^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
  { name: 'Foscam', regex: '^(?<camera>MDAlarm)_(?<ts>\\d{8}-\\d{6})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
];

describe('CameraProfilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [], templates });
    apiMocks.setCameraProfileMode.mockResolvedValue({ mode: 'auto' });
    apiMocks.createCustomProfile.mockResolvedValue(defaultProfile);
    apiMocks.updateCustomProfile.mockResolvedValue({ ...defaultProfile, enabled: false });
    apiMocks.deleteCustomProfile.mockResolvedValue(undefined);
  });

  it('mode select offers exactly two options: auto and custom', async (ctx) => {
    story(ctx, 'Tryb rozpoznawania jest binarny — użytkownik widzi tylko Auto i Własny; pojedyncze tryby producentów zostały zwinięte do Auto.');
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    const opts = Array.from((select as HTMLSelectElement).options).map(o => o.value);
    expect(opts).toEqual(['auto', 'custom']);
  });

  it('displays a legacy single-vendor mode as auto without auto-persisting', async (ctx) => {
    story(ctx, 'Użytkownik z zapisanym starym trybem "reolink" widzi select ustawiony na Auto (zachowanie-zachowujący nadzbiór) i nic nie jest zapisywane samoczynnie.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'reolink', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    expect((select as HTMLSelectElement).value).toBe('auto');
    // No write should happen just from rendering a legacy mode.
    expect(apiMocks.setCameraProfileMode).not.toHaveBeenCalled();
  });

  it('WEB-SET-CAMERAS-014: switching to custom with an empty list resets to the templates first, then saves the mode', async (ctx) => {
    story(ctx, 'Przełączenie na Własny przy pustej liście najpierw zasiewa szablony jednym atomowym wywołaniem serwera, a dopiero potem zapisuje tryb — serwer nigdy nie zostaje w trybie Własny z częścią szablonów.');
    const seeded = templates.map((tpl, i) => ({ ...defaultProfile, id: i + 1, name: tpl.name }));
    apiMocks.resetCameraProfiles.mockResolvedValue({ customProfiles: seeded });
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    fireEvent.change(select, { target: { value: 'custom' } });

    await waitFor(() => expect(apiMocks.setCameraProfileMode).toHaveBeenCalledWith('custom'));
    expect(apiMocks.resetCameraProfiles).toHaveBeenCalledTimes(1);
    expect(apiMocks.resetCameraProfiles.mock.invocationCallOrder[0])
      .toBeLessThan(apiMocks.setCameraProfileMode.mock.invocationCallOrder[0]);
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
  });

  it('WEB-SET-CAMERAS-014: a failed seeding leaves the mode unchanged and shows the error', async (ctx) => {
    story(ctx, 'Gdy zasianie szablonów się nie uda, tryb nie jest zapisywany, lista wraca do poprzedniego trybu, a sekcja pokazuje błąd.');
    apiMocks.resetCameraProfiles.mockRejectedValue(new Error('seed boom'));
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    fireEvent.change(select, { target: { value: 'custom' } });

    expect(await screen.findByText('seed boom')).toBeInTheDocument();
    expect(apiMocks.setCameraProfileMode).not.toHaveBeenCalled();
    expect((select as HTMLSelectElement).value).toBe('auto');
  });

  it('switching to custom does NOT seed when profiles already exist', async (ctx) => {
    story(ctx, 'Jeśli użytkownik ma już własne profile, przełączenie na Własny nie duplikuje szablonów — tylko zmienia tryb.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    fireEvent.change(select, { target: { value: 'custom' } });
    await waitFor(() => expect(apiMocks.setCameraProfileMode).toHaveBeenCalledWith('custom'));
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
  });

  it('custom mode shows profiles list', async (ctx) => {
    story(ctx, 'Po wybraniu trybu "custom" pojawia się lista własnych profili — użytkownik może zarządzać regexami dla swoich kamer.');
    apiMocks.getCameraProfiles.mockResolvedValue({
      mode: 'custom',
      customProfiles: [defaultProfile],
      templates,
    });
    render(<CameraProfilesSection />);
    await waitFor(() => expect(screen.getByText('My Camera')).toBeInTheDocument());
  });

  it('"+ Add profile" button shows the inline form', async (ctx) => {
    story(ctx, 'Kliknięcie przycisku dodawania profilu pokazuje formularz inline — użytkownik może wpisać nazwę i regex bez opuszczania strony.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const btn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(btn);
    expect(screen.getByTestId('profile-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('profile-regex-input')).toBeInTheDocument();
    // A draft: nothing is sent until Save.
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
  });

  it('save calls createCustomProfile with form data', async (ctx) => {
    story(ctx, 'Wypełnienie formularza i kliknięcie Save zapisuje profil przez API — nowy profil pojawia się natychmiast na liście.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);

    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'TestCam' } });
    fireEvent.change(screen.getByTestId('profile-regex-input'), { target: { value: '^(?<camera>test)_(?<ts>\\d{14})\\.(?<ext>mp4)$' } });

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    await waitFor(() =>
      expect(apiMocks.createCustomProfile).toHaveBeenCalledWith({
        name: 'TestCam',
        regex: '^(?<camera>test)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
        viewsConfig: [{ id: '00', iconKind: 'generic' }],
        priority: 10,
      }),
    );

    // After save, form closes and new profile name is visible
    await waitFor(() => expect(screen.getByText('My Camera')).toBeInTheDocument());
  });

  it('per-view editor: add a row and pick an icon, then save sends both views', async (ctx) => {
    story(ctx, 'Użytkownik dodaje drugi widok i wybiera ikonę — Save wysyła pełną tablicę viewsConfig z per-widokowymi ikonami.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);

    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'DualCam' } });
    fireEvent.change(screen.getByTestId('profile-regex-input'), { target: { value: '^(?<camera>x)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$' } });

    // First row defaults to id '00'/generic — set its icon to wide.
    fireEvent.change(screen.getByTestId('profile-view-id-0'), { target: { value: '00' } });
    fireEvent.click(screen.getByTestId('profile-view-icon-0-wide'));

    // Add a second view row, give it id '01' + tele icon.
    fireEvent.click(screen.getByTestId('profile-view-add'));
    fireEvent.change(screen.getByTestId('profile-view-id-1'), { target: { value: '01' } });
    fireEvent.click(screen.getByTestId('profile-view-icon-1-tele'));

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    await waitFor(() =>
      expect(apiMocks.createCustomProfile).toHaveBeenCalledWith({
        name: 'DualCam',
        regex: '^(?<camera>x)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
        viewsConfig: [
          { id: '00', iconKind: 'wide' },
          { id: '01', iconKind: 'tele' },
        ],
        priority: 10,
      }),
    );
  });

  it('a new draft shows the example list and no Reolink template button', async (ctx) => {
    story(ctx, 'Formularz nowego profilu pokazuje listę przykładowych nazw z podglądem na żywo; przycisku szablonu Reolink nie ma.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);
    expect(screen.queryByTestId('profile-reolink-template-btn')).toBeNull();
    expect(screen.getByTestId('example-list')).toBeInTheDocument();
  });

  it('delete button calls deleteCustomProfile', async (ctx) => {
    story(ctx, 'Kliknięcie Delete na profilu i potwierdzenie usuwa go przez API — profil znika z listy bez przeładowania strony.');
    apiMocks.getCameraProfiles.mockResolvedValue({
      mode: 'custom',
      customProfiles: [defaultProfile],
      templates,
    });
    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    const deleteBtn = await screen.findByTestId('profile-delete-btn');
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(apiMocks.deleteCustomProfile).toHaveBeenCalledWith(1));
    // Profile row removed from list
    await waitFor(() => expect(screen.queryByText('My Camera')).toBeNull());
  });

  it('reset to defaults calls the atomic server endpoint — no client-side seed/delete', async (ctx) => {
    story(ctx, 'Reset do domyślnych to jeden atomowy POST /reset — serwer transakcyjnie kasuje i sieje, więc nie ma pustego okna ani konfliktu z capem 20 profili (>16 starych profili blokowało stary seed-first flow).');
    const stale = { ...defaultProfile, id: 99, name: 'StaleCam' };
    const seeded = templates.map((tpl, i) => ({ ...defaultProfile, id: 200 + i, name: tpl.name, priority: (i + 1) * 10 }));
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [stale], templates });
    apiMocks.resetCameraProfiles.mockResolvedValue({ customProfiles: seeded });

    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    const resetBtn = await screen.findByTestId('reset-profiles-btn');
    fireEvent.click(resetBtn);

    await waitFor(() => expect(apiMocks.resetCameraProfiles).toHaveBeenCalledTimes(1));
    // The old client-driven flow must be gone: no per-template creates, no
    // per-profile deletes (they were the source of the cap deadlock).
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
    expect(apiMocks.deleteCustomProfile).not.toHaveBeenCalled();

    // List reflects the endpoint's returned seeded set.
    await waitFor(() => expect(screen.getByText('Foscam')).toBeInTheDocument());
    expect(screen.queryByText('StaleCam')).toBeNull();
  });

  it('reset failure surfaces the error and re-syncs from the server', async (ctx) => {
    story(ctx, 'Awaria resetu — transakcja po stronie serwera się wycofała, klient pokazuje błąd i dociąga aktualny stan listy.');
    const stale = { ...defaultProfile, id: 99, name: 'StaleCam' };
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [stale], templates });
    apiMocks.resetCameraProfiles.mockRejectedValue(new Error('boom'));

    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    fireEvent.click(await screen.findByTestId('reset-profiles-btn'));

    await waitFor(() => expect(apiMocks.resetCameraProfiles).toHaveBeenCalledTimes(1));
    // Best-effort re-sync GET (initial load + post-failure).
    await waitFor(() => expect(apiMocks.getCameraProfiles).toHaveBeenCalledTimes(2));
    // The transaction rolled back server-side, so the stale profile is still there.
    await waitFor(() => expect(screen.getByText('StaleCam')).toBeInTheDocument());
  });

  it('does not show the reset button outside custom mode', async (ctx) => {
    story(ctx, 'Przycisk "Przywróć domyślne" jest dostępny tylko w trybie Własny — w Auto nie ma sensu.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    await screen.findByTestId('camera-profile-mode-select');
    expect(screen.queryByTestId('reset-profiles-btn')).toBeNull();
  });

  it('colours the examples and names the winning profile', async (ctx) => {
    story(ctx, 'Pasujące przykłady mają pokolorowane części, a przy każdym widać profil, który go przejmie według priorytetu.');
    const axis = { ...defaultProfile, id: 2, name: 'Axis', priority: 20, regex: templates[2].regex };
    const reolink = { ...defaultProfile, id: 3, name: 'Reolink', priority: 10, regex: templates[0].regex, viewsConfig: templates[0].viewsConfig };
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [axis, reolink], templates });
    render(<CameraProfilesSection />);
    // Priority 10 sorts first, so Reolink is selected.
    await waitFor(() => expect(screen.getAllByTestId('example-row')[0]).toHaveAttribute('data-state', 'ok'), { timeout: 5000 });
    expect(screen.getAllByTestId('example-row')[0].querySelectorAll('.cp-seg').length).toBe(4);
    await waitFor(() => expect(screen.getAllByTestId('example-row')[0].querySelector('[data-testid="example-winner"]')).toHaveTextContent('settings.cameraProfiles.pg.winsThis'), { timeout: 5000 });
    // The Axis example is won by the Axis profile.
    await waitFor(() => expect(screen.getAllByTestId('example-row')[3].querySelector('[data-testid="example-winner"]')).toHaveTextContent('settings.cameraProfiles.pg.winsOther'), { timeout: 5000 });
    expect(screen.getAllByTestId('example-row')[3]).toHaveAttribute('data-state', 'no');
  });

  it('keeps the overlay out of the accessibility tree and the textarea as the field', async (ctx) => {
    story(ctx, 'Nakładka kolorująca jest ukryta przed czytnikami ekranu; jedynym polem jest textarea.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    expect(await screen.findByTestId('pattern-overlay')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('profile-regex-input').tagName).toBe('TEXTAREA');
  });

  it('save on a stored profile sends only the changed fields', async (ctx) => {
    story(ctx, 'Zapis istniejącego profilu wysyła tylko zmienione pola, a Cofnij przywraca zapisane wartości.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    apiMocks.updateCustomProfile.mockResolvedValue({ ...defaultProfile, priority: 5 });
    render(<CameraProfilesSection />);
    const prio = await screen.findByTestId('profile-priority-input');
    expect(screen.getByTestId('profile-save-btn')).toBeDisabled();
    fireEvent.change(prio, { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('profile-revert-btn'));
    expect((screen.getByTestId('profile-priority-input') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByTestId('profile-priority-input'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    await waitFor(() => expect(apiMocks.updateCustomProfile).toHaveBeenCalledWith(1, { priority: 5 }));
  });

  it('blocks Save while a required group is missing and lists it', async (ctx) => {
    story(ctx, 'Brak grupy ts blokuje zapis, a lista wymaganych grup pokazuje, czego brakuje.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    const ta = await screen.findByTestId('profile-regex-input');
    fireEvent.change(ta, { target: { value: '^(?<camera>[^_]+)_(?<ext>mp4)$' } });
    expect(screen.getByTestId('req-ts')).toHaveClass('is-no');
    expect(screen.getByTestId('req-camera')).toHaveClass('is-ok');
    expect(screen.getByTestId('profile-save-btn')).toBeDisabled();
  });

  it('shows the server refusal inline and keeps the draft', async (ctx) => {
    story(ctx, 'Odmowa serwera (np. zbyt wolny wzorzec) pokazuje się pod edytorem, a szkic zostaje.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    apiMocks.updateCustomProfile.mockRejectedValue(new Error('regex is too slow'));
    render(<CameraProfilesSection />);
    fireEvent.change(await screen.findByTestId('profile-priority-input'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    expect(await screen.findByTestId('profile-save-error')).toHaveTextContent('regex is too slow');
    expect((screen.getByTestId('profile-priority-input') as HTMLInputElement).value).toBe('7');
  });

  it('adds a user file name to the examples and removes it again', async (ctx) => {
    story(ctx, 'Użytkownik dopisuje własną nazwę pliku do przykładów i może ją usunąć.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    fireEvent.change(await screen.findByTestId('regex-test-filename'), { target: { value: 'Yard_20260101120000.mp4' } });
    fireEvent.click(screen.getByTestId('own-name-add'));
    await waitFor(() => expect(screen.getAllByTestId('example-row')).toHaveLength(6));
    await waitFor(() => expect(screen.getAllByTestId('example-row')[5]).toHaveAttribute('data-state', 'ok'), { timeout: 5000 });
    fireEvent.click(screen.getByLabelText('settings.cameraProfiles.pg.removeOwn'));
    expect(screen.getAllByTestId('example-row')).toHaveLength(5);
  });

  it('inserts a named group at the caret', async (ctx) => {
    story(ctx, 'Przycisk grupy wstawia grupę nazwaną w miejscu kursora.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    const ta = (await screen.findByTestId('profile-regex-input')) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '^$' } });
    ta.setSelectionRange(1, 1);
    fireEvent.click(screen.getByTestId('insert-group-ts'));
    expect(ta.value).toBe('^(?<ts>\\d{14})$');
  });

  it('WEB-SET-CAMERAS-045: a new profile whose view ids are not ascending is refused and sends nothing', async (ctx) => {
    story(ctx, 'Formularz nowego profilu nie zapisze widoków, których id nie rosną z góry na dół — najniższe id jest widokiem głównym workera, więc kolejność musi się z nim zgadzać.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    fireEvent.click(await screen.findByTestId('add-profile-btn'));
    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'Swapped' } });
    fireEvent.change(screen.getByTestId('profile-regex-input'), { target: { value: '^(?<camera>x)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$' } });
    fireEvent.change(screen.getByTestId('profile-view-id-0'), { target: { value: '01' } });
    fireEvent.click(screen.getByTestId('profile-view-add'));
    fireEvent.change(screen.getByTestId('profile-view-id-1'), { target: { value: '00' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(await screen.findByText('settings.cameraProfiles.viewsOrderError')).toBeInTheDocument();
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
  });

  it('WEB-SET-CAMERAS-045: saving the views of an existing profile with a duplicate id is refused', async (ctx) => {
    story(ctx, 'Zapis widoków istniejącego profilu z powtórzonym id jest odrzucany lokalnie z komunikatem — żadne żądanie nie idzie do serwera.');
    apiMocks.getCameraProfiles.mockResolvedValue({
      mode: 'custom',
      customProfiles: [{ ...defaultProfile, viewsConfig: [{ id: '00', iconKind: 'wide' as const }, { id: '01', iconKind: 'zoom' as const }] }],
      templates,
    });
    render(<CameraProfilesSection />);
    fireEvent.click(await screen.findByText('My Camera'));
    fireEvent.change(await screen.findByTestId('profile-view-id-1'), { target: { value: '00' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(await screen.findByText('settings.cameraProfiles.viewsOrderError')).toBeInTheDocument();
    expect(apiMocks.updateCustomProfile).not.toHaveBeenCalled();
  });
});
