// The parts of the smoke test that decide when it may go on and what it prints
// when it stops: whether the thumbnail worker reads its stream, and how a log
// is cut down to something a person can read in a CI log.
//
//   node --test 'scripts/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamEntries, tailLines, workerConsumers } from './smoke-test.mjs';

// `redis-cli --raw XINFO GROUPS stream:thumbnail` prints every group as
// name/value lines, one after the other. A value Redis has not got (nil) is an
// empty line, so the pairs stay in step.
const group = (name, consumers) => [
  'name', name, 'consumers', String(consumers), 'pending', '0',
  'last-delivered-id', '1763700000000-0', 'entries-read', '', 'lag', '0',
].join('\n');

test('the worker has not joined while the stream or its group does not exist', () => {
  assert.equal(workerConsumers(''), 0);
  assert.equal(workerConsumers('ERR no such key'), 0);
  assert.equal(workerConsumers('\n'), 0);
});

test('a group without a consumer is not a worker that reads', () => {
  assert.equal(workerConsumers(group('thumbnail-workers', 0)), 0);
});

test('the worker has joined as soon as its group has a consumer', () => {
  assert.equal(workerConsumers(group('thumbnail-workers', 1)), 1);
  assert.equal(workerConsumers(group('thumbnail-workers', 2)), 2);
});

test('only the group of the thumbnail workers counts', () => {
  assert.equal(workerConsumers(group('someone-else', 3)), 0);
  assert.equal(workerConsumers(`${group('someone-else', 3)}\n${group('thumbnail-workers', 0)}`), 0);
  assert.equal(workerConsumers(`${group('someone-else', 3)}\n${group('thumbnail-workers', 2)}`), 2);
  assert.equal(workerConsumers(`${group('thumbnail-workers', 2)}\n${group('someone-else', 3)}`), 2);
});

test('an empty value does not shift the fields after it', () => {
  const text = ['name', 'thumbnail-workers', 'entries-read', '', 'lag', '', 'consumers', '4'].join('\n');
  assert.equal(workerConsumers(text), 4);
});

test('tailLines keeps the last lines', () => {
  assert.equal(tailLines('a\nb\nc\nd', 2, 80), 'c\nd');
  assert.equal(tailLines('a\nb', 5, 80), 'a\nb');
});

test('tailLines cuts a long line, keeping its beginning (time, level, name)', () => {
  const cut = tailLines(`2026-11-21T01:21:51Z INFO ${'x'.repeat(500)}`, 1, 40);
  assert.equal(cut.length, 40);
  assert.ok(cut.startsWith('2026-11-21T01:21:51Z INFO xxx'));
  assert.ok(cut.endsWith('…'));
});

test('tailLines leaves out colour codes, empty lines and trailing spaces', () => {
  const text = '\u001b[2m2026-11-21\u001b[0m \u001b[32m INFO\u001b[0m  \n\n   \nnext line   \n';
  assert.equal(tailLines(text, 10, 80), '2026-11-21  INFO\nnext line');
});

test('tailLines counts the lines it keeps after cleaning, not before', () => {
  assert.equal(tailLines('a\n\n\n\nb\n\n', 2, 80), 'a\nb');
});

test('streamEntries puts every entry on one line and shows the time its id carries', () => {
  const text = ['1763700000000-0', 'eventId', 'abc', 'ownerId', '1', 'notify', 'true', '1763700001000-3', 'eventId', 'def'].join('\n');
  assert.deepEqual(streamEntries(text), [
    '1763700000000-0 (2025-11-21T04:40:00.000Z) eventId abc ownerId 1 notify true',
    '1763700001000-3 (2025-11-21T04:40:01.000Z) eventId def',
  ]);
});

test('streamEntries has nothing to show for an empty stream or an error', () => {
  assert.deepEqual(streamEntries(''), []);
  assert.deepEqual(streamEntries('ERR no such key'), []);
});
