// The FTPS server's TLS key [ARCH-106].
//
// The FTPS image runs the server as uid 1001 in a SYSTEM group (`groupadd -r`),
// and that group's number is not 1001. A key that is shared through "group 1001"
// is therefore unreadable for the server, which then does not start. The key has
// to belong to the user.
//
//   node --test 'scripts/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const script = read('docker/init-certs.sh');
const dockerfile = read('docker/ftps.Dockerfile');
const compose = read('docker-compose.yml');

const uid = /useradd[^\n]*-u (\d+)/.exec(dockerfile)?.[1];

test('the FTPS image creates its user with a fixed uid', () => {
  assert.ok(uid, 'docker/ftps.Dockerfile must create the FTPS user with -u <uid>');
});

test('the compose file runs the FTPS server as that uid', () => {
  const service = /\n {2}klipgard-ftps:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/.exec(compose)?.[1] ?? '';
  assert.match(service, new RegExp(`^    user: "${uid}"$`, 'm'));
});

test('init-certs gives the TLS key to that uid, not to a group [ARCH-106]', () => {
  assert.match(script, new RegExp(`^chown ${uid}:\\S+ /certs/privkey\\.pem$`, 'm'));
  assert.match(script, /^chmod 400 \/certs\/privkey\.pem$/m);
});

test('init-certs does not leave the key to root with a group', () => {
  // The broken variant: owner root, group <uid>. The server's own group is a
  // different number, so it falls into "others" and cannot read the file.
  assert.doesNotMatch(script, /^chown 0:\S+ \/certs\/privkey\.pem/m);
});

test('init-certs corrects the key on every start, not only when it creates it', () => {
  // The permission lines sit outside any `if [ ! -f ... ]` block, so an installation
  // that keeps an older permission is corrected on update.
  const lines = script.split('\n');
  const at = lines.findIndex((l) => /^chown \d+:\S+ \/certs\/privkey\.pem$/.test(l));
  assert.ok(at > 0, 'the chown line exists');
  const open = lines.slice(0, at).filter((l) => /^if /.test(l)).length;
  const closed = lines.slice(0, at).filter((l) => /^fi$/.test(l)).length;
  assert.equal(open, closed, 'the chown line is not inside an if block');
});
