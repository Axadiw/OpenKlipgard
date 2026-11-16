import type { Server } from 'node:http';

/**
 * [API-CORE-076] Keep an idle client connection open for 120 s.
 *
 * Node closes an idle connection after 5 s by default. A client that pools connections
 * (the FTPS server's HTTP client) then sends its next request on a connection that is
 * being closed, and sees `error sending request` instead of an answer: a camera's login
 * became `530` for a valid account. `headersTimeout` must stay above `keepAliveTimeout`.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 120_000;
export const HEADERS_TIMEOUT_MS = 125_000;

export function tuneListener(server: Server): Server {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
