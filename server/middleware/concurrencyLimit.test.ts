import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';
import {
  videoConcurrencyCap,
  getInFlightVideoCount,
  _resetForTesting,
  _getLimitForTesting,
  _getPerUserLimitForTesting,
} from './concurrencyLimit.js';

/**
 * Minimal stand-in for an Express Response. The middleware only touches
 * `setHeader`, `status`, `json`, and `once('close', …)`.
 */
interface FakeRes extends EventEmitter {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  setHeader(k: string, v: string | number | readonly string[]): FakeRes;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const e = new EventEmitter() as FakeRes;
  e.headers = {};
  e.setHeader = function (k, v) { this.headers[k] = String(v); return this; };
  e.status = function (c) { this.statusCode = c; return this; };
  e.json = function (b) { this.body = b; return this; };
  return e;
}

function makeReq(): Request {
  return {} as Request;
}

function makeNext(): NextFunction & Mock {
  return vi.fn() as unknown as NextFunction & Mock;
}

beforeEach(() => {
  _resetForTesting();
});

describe('videoConcurrencyCap — per-pod /video request limiter', () => {
  it('lets requests through up to the cap, then 429s', (ctx) => {
    const limit = _getLimitForTesting();
    story(
      ctx,
      `Globalny cap=${limit} chroni pulę S3 keep-alive socketów przed nasyceniem. Dopóki <${limit} streamów jest in-flight, każdy nowy request przechodzi do route handlera. ${limit + 1}-szy dostaje 429 + Retry-After: 3 — frontend retry'uje po backoffie, pod nie dostaje punktu.`,
    );
    const next = makeNext();
    const responses: FakeRes[] = [];

    for (let i = 0; i < limit; i++) {
      const r = makeRes();
      responses.push(r);
      videoConcurrencyCap(makeReq(), r as unknown as Response, next);
    }
    expect(next).toHaveBeenCalledTimes(limit);
    expect(getInFlightVideoCount()).toBe(limit);

    // Overflow request → 429.
    next.mockClear();
    const overflow = makeRes();
    videoConcurrencyCap(makeReq(), overflow as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(overflow.statusCode).toBe(429);
    expect(overflow.body).toMatchObject({ code: 'VIDEO_CONCURRENCY_LIMIT_REACHED' });
    expect(overflow.headers['Retry-After']).toBe('3');
    // Counter unchanged — overflow nie zajął slotu.
    expect(getInFlightVideoCount()).toBe(limit);
  });

  it('drains the counter on res close (both normal completion and client abort)', (ctx) => {
    story(
      ctx,
      'Najważniejszy invariant: każdy zajęty slot MUSI się zwolnić, niezależnie czy stream skończył się czysto, klient zerwał (Chrome close, mobile drop), czy upstream upadł. Bez tego cap byłby self-reinforcing — każdy abort permanent blokowałby slot, prowadząc do unbounded 429 po kilku minutach.',
    );
    const res = makeRes();
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    expect(getInFlightVideoCount()).toBe(1);

    res.emit('close'); // simulates both abort AND clean finish — same event
    expect(getInFlightVideoCount()).toBe(0);
  });

  it('release is idempotent (double-close does not decrement twice)', (ctx) => {
    story(
      ctx,
      'Node EventEmitters potrafią emitować close po finish w edge-case-ach. Idempotentny release zapobiega ujemnemu licznikowi (który by oznaczał że cap "myśli" iż jest miejsce, gdy realnie nie ma — i pool by się zwedge-ował).',
    );
    const res = makeRes();
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    res.emit('close');
    res.emit('close');
    expect(getInFlightVideoCount()).toBe(0);
  });

  it('slot stays held after close until the held work settles', async (ctx) => {
    story(
      ctx,
      'Slot nie wraca do puli, dopóki handler wciąż trzyma socket S3 albo bufor: po zerwaniu połączenia zwalniamy dopiero, gdy praca się skończy, inaczej klient mógłby zerwać i ponowić w pętli bez limitu.',
    );
    const res = makeRes() as FakeRes & { locals: Record<string, unknown> };
    res.locals = {};
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    let finish!: () => void;
    const work = new Promise<void>((r) => { finish = r; });
    (res.locals.holdVideoSlot as (p: Promise<unknown>) => void)(work);

    res.emit('close');
    await Promise.resolve();
    expect(getInFlightVideoCount()).toBe(1);

    finish();
    await work;
    await Promise.resolve();
    expect(getInFlightVideoCount()).toBe(0);
  });

  it('a held promise that rejects still releases the slot', async (ctx) => {
    story(ctx, 'Błąd w handlerze nie może zablokować slotu na zawsze.');
    const res = makeRes() as FakeRes & { locals: Record<string, unknown> };
    res.locals = {};
    videoConcurrencyCap(makeReq(), res as unknown as Response, makeNext());
    const work = Promise.reject(new Error('boom'));
    (res.locals.holdVideoSlot as (p: Promise<unknown>) => void)(work);
    res.emit('close');
    await new Promise((r) => setTimeout(r, 0));
    expect(getInFlightVideoCount()).toBe(0);
  });
});

describe('videoConcurrencyCap — per-account ceiling (API-EVENTS-296)', () => {
  const reqFor = (id: string): Request => ({ user: { userUuid: id } }) as unknown as Request;

  it('429s the over-limit account only and frees slots exactly once', () => {
    const lim = _getPerUserLimitForTesting();
    const next = makeNext();
    const held: FakeRes[] = [];
    for (let i = 0; i < lim; i++) {
      const r = makeRes();
      held.push(r);
      videoConcurrencyCap(reqFor('a'), r as unknown as Response, next);
    }
    expect(next).toHaveBeenCalledTimes(lim);

    const over = makeRes();
    videoConcurrencyCap(reqFor('a'), over as unknown as Response, next);
    expect(over.statusCode).toBe(429);
    expect((over.body as { code: string }).code).toBe('VIDEO_CONCURRENCY_LIMIT_REACHED');
    expect(over.headers['Retry-After']).toBe('3');
    expect(next).toHaveBeenCalledTimes(lim);

    const other = makeRes();
    videoConcurrencyCap(reqFor('b'), other as unknown as Response, next);
    expect(other.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(lim + 1);

    held[0].emit('close');
    held[0].emit('close');
    const again = makeRes();
    videoConcurrencyCap(reqFor('a'), again as unknown as Response, next);
    expect(again.statusCode).toBeUndefined();
    const again2 = makeRes();
    videoConcurrencyCap(reqFor('a'), again2 as unknown as Response, next);
    expect(again2.statusCode).toBe(429);
  });
});
