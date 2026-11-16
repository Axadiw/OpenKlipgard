import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountDiscovery } from './discovery.js';

describe('.well-known discovery', () => {
  const app = express();
  mountDiscovery(app);

  it('[MCP-010] GET /.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://klipgard.example/mcp');
    expect(res.body.authorization_servers).toEqual(['https://klipgard.example']);
    expect(res.body.bearer_methods_supported).toEqual(['header']);
    expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['videos:read', 'videos:delete']));
    // Unset in this suite: a self-hosted install has no /help/mcp page to advertise.
    expect(res.body).not.toHaveProperty('resource_documentation');
  });

  it('[MCP-010] advertises resource_documentation only when MCP_RESOURCE_DOCUMENTATION_URL is set', async () => {
    vi.stubEnv('MCP_RESOURCE_DOCUMENTATION_URL', 'https://klipgard.example/help/mcp');
    vi.resetModules();
    try {
      const { mountDiscovery: mountFresh } = await import('./discovery.js');
      const cloudApp = express();
      mountFresh(cloudApp);
      const res = await request(cloudApp).get('/.well-known/oauth-protected-resource');
      expect(res.status).toBe(200);
      expect(res.body.resource_documentation).toBe('https://klipgard.example/help/mcp');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('[MCP-010] a blank MCP_RESOURCE_DOCUMENTATION_URL leaves the field out', async () => {
    vi.stubEnv('MCP_RESOURCE_DOCUMENTATION_URL', '  ');
    vi.resetModules();
    try {
      const { mountDiscovery: mountFresh } = await import('./discovery.js');
      const selfApp = express();
      mountFresh(selfApp);
      const res = await request(selfApp).get('/.well-known/oauth-protected-resource');
      expect(res.body).not.toHaveProperty('resource_documentation');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://klipgard.example');
    expect(res.body.authorization_endpoint).toBe('https://klipgard.example/mcp/oauth/authorize');
    expect(res.body.token_endpoint).toBe('https://klipgard.example/mcp/oauth/token');
    expect(res.body.registration_endpoint).toBe('https://klipgard.example/mcp/oauth/register');
    expect(res.body.revocation_endpoint).toBe('https://klipgard.example/mcp/oauth/revoke');
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(res.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.response_types_supported).toEqual(['code']);
    expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['videos:read', 'videos:delete']));
  });
});
