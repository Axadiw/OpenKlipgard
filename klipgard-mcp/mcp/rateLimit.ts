import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, type RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedis } from '../../server/utils/redis.js';

export interface RateLimitOpts {
  points: number;
  durationSec: number;
  keyPrefix: string;
}

/**
 * rate-limiter-flexible rejects with a RateLimiterRes when the budget is spent
 * and with a plain Error when the store fails (Redis down). Only the first is
 * a rate-limit answer; the second must fail open [MCP-025] [MCP-095].
 */
export function isStoreFailure(rejected: unknown): rejected is Error {
  return rejected instanceof Error;
}

/**
 * Per-token budget for MCP calls, counted in Redis so every replica shares
 * it. `store` replaces the Redis limiter — tests pass an in-memory one.
 */
export function perTokenRateLimit(opts: RateLimitOpts, store?: RateLimiterAbstract) {
  const limiter = store ?? new RateLimiterRedis({
    storeClient: getRedis(),
    keyPrefix: opts.keyPrefix,
    points: opts.points,
    duration: opts.durationSec,
  });
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = (req as any).tokenForLimit ?? req.ip ?? 'anon';
    try {
      await limiter.consume(key);
      next();
    } catch (e: any) {
      if (isStoreFailure(e)) {
        // Rate limiting is defence in depth, not the auth gate: a Redis outage
        // must not turn every /mcp call into a 429. Same as the API limiters.
        console.error(`MCP rate limit store error (${opts.keyPrefix}):`, e.message);
        next();
        return;
      }
      res.set('Retry-After', String(Math.ceil((e?.msBeforeNext ?? 60_000) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
    }
  };
}
