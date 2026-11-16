import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StorageSection } from './StorageSection';
import { story } from '../test-story';

const apiMocks = vi.hoisted(() => ({
  getUsage: vi.fn(),
  getUsageByCamera: vi.fn(),
  getAutoDelete: vi.fn(),
  getAutoDeleteAfterDays: vi.fn(),
  setAutoDelete: vi.fn(),
  setAutoDeleteAfterDays: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));
vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));

const GB = 1024 ** 3;

describe('StorageSection — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getUsage.mockResolvedValue({
      disk: { usageBytes: GB, limitBytes: 4 * GB, percent: 25 },
      transfer: { usageBytes: 0, limitBytes: 0, percent: 0, resetAt: null },
    });
    apiMocks.getUsageByCamera.mockResolvedValue({ cameras: [] });
    apiMocks.getAutoDelete.mockResolvedValue({ enabled: false });
    apiMocks.getAutoDeleteAfterDays.mockResolvedValue({ days: 30 });
  });

  it('WEB-SET-STORAGE-042: a failed auto-delete save keeps the switch off and shows the inline error', async (ctx) => {
    story(ctx, 'Gdy zapis przełącznika "usuwaj najstarsze" zawiedzie, przełącznik zostaje wyłączony, a pod podpowiedzią pojawia się komunikat; kolejne przełączenie go czyści.');
    apiMocks.setAutoDelete.mockRejectedValueOnce(new Error('boom'));
    render(<StorageSection />);
    const toggle = await screen.findByLabelText('settings.autoDeleteOldest');
    await waitFor(() => expect(toggle).not.toBeDisabled());

    fireEvent.click(toggle);
    expect(await screen.findByTestId('auto-delete-save-failed')).toHaveTextContent('settings.autoDeleteSaveFailed');
    expect(toggle).not.toBeChecked();

    apiMocks.setAutoDelete.mockResolvedValueOnce({});
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('auto-delete-save-failed')).not.toBeInTheDocument());
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('WEB-SET-STORAGE-055: a failed retention save shows the inline error and keeps the stepper value', async (ctx) => {
    story(ctx, 'Gdy zapis okna retencji zawiedzie (po 600 ms debounce), pod stepperem pojawia się komunikat, a stepper zachowuje wpisaną wartość; udana zmiana czyści komunikat.');
    apiMocks.setAutoDeleteAfterDays.mockRejectedValueOnce(new Error('boom'));
    render(<StorageSection />);
    const plus = await screen.findByLabelText('+1');

    fireEvent.click(plus);
    expect(await screen.findByTestId('auto-delete-days-save-failed', undefined, { timeout: 3000 }))
      .toHaveTextContent('settings.autoDeleteAfterDaysSaveFailed');
    expect(screen.getByDisplayValue('31')).toBeInTheDocument();

    apiMocks.setAutoDeleteAfterDays.mockResolvedValueOnce({});
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await waitFor(() => expect(screen.queryByTestId('auto-delete-days-save-failed')).not.toBeInTheDocument());
  });
});
