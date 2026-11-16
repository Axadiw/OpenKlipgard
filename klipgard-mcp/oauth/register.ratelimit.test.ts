import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// The limiter store is replaced so the suite needs no Redis and no database:
// what is under test is how /register reads a limiter rejection.
const { consume, createClient, writeAuditLog } = vi.hoisted(() => ({
  consume: vi.fn(),
  createClient: vi.fn(async () => 'client-1'),
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock('rate-limiter-flexible', () => ({
  RateLimiterRedis: class { consume = consume; },
  RateLimiterMemory: class { consume = consume; },
}));
vi.mock('../../server/utils/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../db/queries.js', () => ({ createClient, writeAuditLog }));

import { mountRegister } from './register.js';

const BODY = { client_name: 'Claude Desktop', redirect_uris: ['http://127.0.0.1:54321/cb'] };

describe('POST /mcp/oauth/register limiter', () => {
  const app = express();
  app.use(express.json());
  mountRegister(app);

  beforeEach(() => { consume.mockReset(); });

  it('[MCP-025] registers anyway when the limiter store fails (Redis down)', async () => {
    consume.mockRejectedValue(new Error('Connection is closed.'));
    const res = await request(app).post('/mcp/oauth/register').send(BODY);
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('client-1');
  });

  it('[MCP-025] answers 429 with Retry-After when the budget is spent', async () => {
    consume.mockRejectedValue({ msBeforeNext: 1500, remainingPoints: 0 });
    const res = await request(app).post('/mcp/oauth/register').send(BODY);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited' });
    expect(res.headers['retry-after']).toBe('2');
  });
});
