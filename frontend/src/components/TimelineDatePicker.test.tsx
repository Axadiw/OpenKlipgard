import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineDatePicker } from './TimelineDatePicker';
import { clearAccountTimezone, ACCOUNT_TZ_KEY } from '../hooks/useAccountTimezone';
import { story } from '../test-story';

vi.mock('../api', () => ({
  api: {
    // Never settles: the zone under test comes from the local cache the hook seeds from.
    getAccountTimezone: () => new Promise(() => {}),
    getEventCalendar: () => Promise.resolve({ days: [] }),
  },
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

afterEach(() => {
  vi.useRealTimers();
  clearAccountTimezone();
});

// 20:00 UTC on 7 April is already 8 April in Tokyo and still 7 April in New York.
function renderAt(accountTz: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-07T20:00:00.000Z'));
  clearAccountTimezone();
  localStorage.setItem(ACCOUNT_TZ_KEY, accountTz);
  const onSelect = vi.fn();
  render(<TimelineDatePicker selectedDate={new Date(2026, 3, 7)} onSelect={onSelect} onClose={() => {}} />);
  return onSelect;
}

describe('TimelineDatePicker — "today" is the account clock', () => {
  it('[WEB-TIMELINE-069] marks and enables the account current day, and disables the days after it', async (ctx) => {
    story(ctx, 'Kalendarz liczył „dzisiaj” z zegara przeglądarki, więc blisko północy realne „dzisiaj” konta mogło być wyszarzone jako przyszłość. Dla konta w Tokio o 20:00 UTC jest już 8 kwietnia: ten dzień jest dzisiejszy i klikalny, a 9 kwietnia już nie.');
    renderAt('Asia/Tokyo');
    const today = await screen.findByTestId('timeline-datepicker-day-2026-04-08');
    expect(today).toHaveClass('today');
    expect(today).not.toBeDisabled();
    expect(screen.getByTestId('timeline-datepicker-day-2026-04-09')).toBeDisabled();
    expect(screen.getByTestId('timeline-datepicker-day-2026-04-07')).not.toHaveClass('today');
  });

  it('[WEB-TIMELINE-069] disables the day the browser calls today when the account is still a day behind', async (ctx) => {
    story(ctx, 'Odwrotny przypadek: konto w Nowym Jorku o 20:00 UTC wciąż ma 7 kwietnia, więc 8 kwietnia jest przyszłością, nawet gdyby zegar przeglądarki już ją pokazywał.');
    renderAt('America/New_York');
    expect(await screen.findByTestId('timeline-datepicker-day-2026-04-07')).toHaveClass('today');
    expect(screen.getByTestId('timeline-datepicker-day-2026-04-08')).toBeDisabled();
  });

  it('[WEB-TIMELINE-069] the Today button picks the account current day', async (ctx) => {
    story(ctx, 'Przycisk „Dzisiaj” w stopce ramuje ten sam dzień, który oś czasu uważa za dzisiejszy (WEB-TIMELINE-019), a nie dzień z zegara przeglądarki.');
    const onSelect = renderAt('Asia/Tokyo');
    fireEvent.click(await screen.findByTestId('timeline-datepicker-today'));
    const picked = onSelect.mock.calls[0][0] as Date;
    expect([picked.getFullYear(), picked.getMonth() + 1, picked.getDate()]).toEqual([2026, 4, 8]);
  });
});

describe('TimelineDatePicker — next-month button', () => {
  // Account zone = the zone of the test machine, so the account day is the local day.
  function renderMonth(selected: Date) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)); // 15 July 2026, local time
    clearAccountTimezone();
    localStorage.setItem(ACCOUNT_TZ_KEY, Intl.DateTimeFormat().resolvedOptions().timeZone);
    render(<TimelineDatePicker selectedDate={selected} onSelect={() => {}} onClose={() => {}} />);
    return screen.getByTestId('timeline-datepicker-next');
  }

  it('[WEB-TIMELINE-069] is disabled while the visible month is the current month', (ctx) => {
    story(ctx, 'Kalendarz otwarty na bieżącym miesiącu nie pozwala klikać strzałki "następny miesiąc" — w przyszłości nie ma nagrań.');
    expect(renderMonth(new Date(2026, 6, 10))).toBeDisabled();
  });

  it('[WEB-TIMELINE-069] is enabled in a past month and disables again on reaching the current month', (ctx) => {
    story(ctx, 'W miesiącu z przeszłości strzałka "następny miesiąc" działa, ale po dojściu do bieżącego miesiąca znów się dezaktywuje.');
    const next = renderMonth(new Date(2026, 4, 10));
    expect(next).not.toBeDisabled();
    fireEvent.click(next); // June
    expect(next).not.toBeDisabled();
    fireEvent.click(next); // July, the current month
    expect(next).toBeDisabled();
  });
});
