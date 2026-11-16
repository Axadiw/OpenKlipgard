import { describe, it, expect, vi } from 'vitest';

const row = {
  id: 9, userId: 42, kind: 'invalid_file', message: 'Bad upload',
  details: { filename: 'x.mp4' }, readAt: null, createdAt: new Date('2026-04-15T10:00:00Z'),
};

vi.mock('../index.js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy']) chain[m] = () => chain;
  chain.limit = async () => [row];
  return { db: { select: () => chain }, withTx: vi.fn() };
});

import { listNotifications } from './notifications.js';

describe('notification rows', () => {
  it('[API-CORE-099] carry no internal account id', async () => {
    const [n] = await listNotifications(42);
    expect(n).toEqual({
      id: '9', kind: 'invalid_file', message: 'Bad upload',
      details: { filename: 'x.mp4' }, readAt: null, createdAt: '2026-04-15T10:00:00.000Z',
    });
    expect(n).not.toHaveProperty('userId');
  });
});
