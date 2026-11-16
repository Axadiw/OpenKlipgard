import { internalApiKeyFromEnv } from '../server/utils/internalApiKey.js';

export const MCP_CONFIG = {
  port: Number(process.env.MCP_PORT ?? 3100),
  // Public origin the MCP endpoints are reachable at. Same origin as the web
  // app by default (the reverse proxy routes /mcp and /.well-known/oauth-* here).
  publicMcpUrl: (process.env.PUBLIC_MCP_URL ?? process.env.PUBLIC_APP_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  internalApiKey: internalApiKeyFromEnv(),
  // `resource_documentation` of the discovery document [MCP-010]. Unset => the
  // field is left out. Klipgard Cloud sets the /help/mcp page of its web app; a
  // self-hosted web app has no such route, so it must not advertise one.
  resourceDocumentationUrl: process.env.MCP_RESOURCE_DOCUMENTATION_URL?.trim() || undefined,
} as const;
