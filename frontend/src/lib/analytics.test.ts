import { afterEach, describe, expect, it, vi } from 'vitest';
import { story } from '../test-story';
import { ApiError } from '../api';
import { analyticsErrorCode, analyticsView, countBucket, installAnalyticsSink, track } from './analytics';

afterEach(() => installAnalyticsSink(undefined));

describe('lib/analytics', () => {
  it('drops events when no edition installed a sink', (ctx) => {
    story(ctx, 'Wspólny rdzeń (także OpenKlipgard) bez zainstalowanego odbiorcy nie wysyła niczego i nie rzuca.');
    expect(() => track('logout', { scope: 'device' })).not.toThrow();
  });

  it('forwards events to the installed sink', (ctx) => {
    story(ctx, 'Edycja chmurowa instaluje odbiorcę i dostaje nazwę zdarzenia z parametrami.');
    const sink = vi.fn();
    installAnalyticsSink(sink);
    track('video_play', { surface: 'grid', view: 'wide' });
    expect(sink).toHaveBeenCalledWith('video_play', { surface: 'grid', view: 'wide' });
  });

  it('a throwing sink never breaks the caller', (ctx) => {
    story(ctx, 'Błąd w analityce nie może zepsuć akcji użytkownika.');
    installAnalyticsSink(() => { throw new Error('boom'); });
    expect(() => track('event_delete', {})).not.toThrow();
  });

  it('error codes are bounded: the API code or a class, never the message', (ctx) => {
    story(ctx, 'login_error niesie kod API albo klasę błędu — nigdy treść komunikatu, która mogłaby zawierać dane.');
    expect(analyticsErrorCode(new ApiError('Konto jan@example.com', 403, { code: 'EMAIL_NOT_VERIFIED' }))).toBe('EMAIL_NOT_VERIFIED');
    expect(analyticsErrorCode(new ApiError('x', 401))).toBe('invalid_credentials');
    expect(analyticsErrorCode(new ApiError('x', 429))).toBe('rate_limited');
    expect(analyticsErrorCode(new ApiError('x', 400, { code: 'not a code jan@example.com' }))).toBe('http_400');
    expect(analyticsErrorCode(new ApiError('x', 502))).toBe('server_error');
    expect(analyticsErrorCode(new TypeError('Failed to fetch'))).toBe('network');
    expect(analyticsErrorCode(new DOMException('cancelled', 'NotAllowedError'))).toBe('passkey_cancelled');
    expect(analyticsErrorCode('weird')).toBe('unknown');
  });

  it('counts and views map to small fixed sets', (ctx) => {
    story(ctx, 'Liczby są kubełkowane, a własne identyfikatory widoków z profili kamer raportowane jako other.');
    expect([1, 2, 10, 11, 50, 51, 999].map(countBucket)).toEqual(['1', '2-10', '2-10', '11-50', '11-50', '51+', '51+']);
    expect(analyticsView('00')).toBe('wide');
    expect(analyticsView('01')).toBe('zoom');
    expect(analyticsView('Garaż przód')).toBe('other');
  });
});
