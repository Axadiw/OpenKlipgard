import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { story } from './testing/story.js';
import { tuneListener, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from './httpServer.js';

describe('API listener keep-alive (API-CORE-076)', () => {
  it('keeps an idle client connection for 120 s and reads headers for 125 s', (ctx) => {
    story(
      ctx,
      'Nasłuch API trzyma bezczynne połączenie klienta przez 120 s (domyślne 5 s zamykało je akurat wtedy, gdy serwer FTPS wysyłał po nim kolejne żądanie logowania — kamera dostawała 530). headersTimeout musi być większy niż keepAliveTimeout.',
    );
    const server = tuneListener(http.createServer());
    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(125_000);
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it('is longer than the 30 s the FTPS client keeps a pooled connection (FTPS-156)', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
