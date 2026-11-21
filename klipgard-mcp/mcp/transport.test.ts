import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountMcpTransport } from './transport.js';

describe('mountMcpTransport', () => {
  it('mounts POST /mcp and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('mounts GET /mcp (SSE upgrade) and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('mounts DELETE /mcp (session terminate) and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).delete('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });
});

// [MCP-096] GET never opens an SSE stream: no per-grant idle-stream cap needed.
describe('GET /mcp after authentication', () => {
  it('answers 405 with Allow and no event-stream, so no idle stream can be held open', async () => {
    vi.resetModules();
    vi.doMock('./bearerAuth.js', () => ({
      bearerAuthMcp: (req: any, _res: any, next: any) => {
        req.mcpAuth = { userId: 1, clientId: 'c', scope: 'videos:read', familyId: 'f', resource: 'r' };
        req.tokenForLimit = 't';
        next();
      },
    }));
    vi.doMock('./rateLimit.js', () => ({
      perTokenRateLimit: () => (_req: any, _res: any, next: any) => next(),
    }));
    const { mountMcpTransport: mount } = await import('./transport.js');
    const app = express();
    app.use(express.json());
    mount(app);
    const res = await request(app).get('/mcp').set('Accept', 'text/event-stream');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST, DELETE');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    vi.doUnmock('./bearerAuth.js');
    vi.doUnmock('./rateLimit.js');
  });
});
