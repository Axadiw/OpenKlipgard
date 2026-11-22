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

// ── the camera address [ARCH-108] ──────────────────────────────────────────
// init-certs asks docker/ftp-host.sh for it (FTP_HOST, or the host of
// PUBLIC_URL), so a bad setting stops `docker compose up` here, before the API
// or the FTP server starts. The script itself is tested in ftp-host.test.mjs.

test('init-certs resolves the camera address at every start, before it makes anything [ARCH-108]', () => {
  const lines = script.split('\n');
  const at = lines.indexOf('ftp_host=$(/bin/sh /ftp-host.sh)');
  assert.ok(at > 0, 'init-certs runs docker/ftp-host.sh and keeps its answer');
  const open = lines.slice(0, at).filter((l) => /^if /.test(l)).length;
  const closed = lines.slice(0, at).filter((l) => /^fi$/.test(l)).length;
  assert.equal(open, closed, 'the resolver is not inside an if block');
  const firstCertificate = lines.findIndex((l) => /openssl (genrsa|req)/.test(l));
  assert.ok(firstCertificate > at, 'a refused address stops init-certs before it makes a certificate');
});

test('init-certs leaves the address for the FTP server and names the FTPS certificate after it [ARCH-108]', () => {
  const lines = script.split('\n');
  assert.ok(lines.includes('printf \'%s\\n\' "$ftp_host" > /certs/ftp-host'));
  assert.ok(lines.includes('chmod 644 /certs/ftp-host'));
  assert.match(script, /-subj "\/CN=\$\{ftp_host\}"/);
  assert.doesNotMatch(script, /\$\{?FTP_HOST/, 'only the resolver reads FTP_HOST');
});

const serviceBlock = (name) => new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n {2}[a-z][\\w-]*:\\n`).exec(compose)?.[1] ?? '';

test('the compose file gives init-certs the resolver [ARCH-108]', () => {
  assert.match(serviceBlock('init-certs'), /^ {6}- \.\/docker\/ftp-host\.sh:\/ftp-host\.sh:ro$/m);
});

test('the FTPS image carries its own entrypoint, runnable by the FTPS user whatever the host umask [ARCH-108]', () => {
  const lines = dockerfile.split('\n');
  const copy = lines.indexOf('COPY docker/ftps-entrypoint.sh /usr/local/bin/ftps-entrypoint.sh');
  const chmod = lines.indexOf('RUN chmod 0755 /usr/local/bin/ftps-entrypoint.sh');
  const user = lines.indexOf('USER ftps');
  assert.ok(copy > 0, 'the Dockerfile copies the entrypoint into the image');
  assert.ok(chmod > copy && user > chmod, 'it is made executable for everyone while the build still runs as root');
  const entrypoint = lines.indexOf('ENTRYPOINT ["/usr/local/bin/ftps-entrypoint.sh"]');
  const cmd = lines.indexOf('CMD ["klipgard-ftps"]');
  assert.ok(entrypoint > user, 'the image starts through the entrypoint');
  assert.ok(cmd > entrypoint, 'the server stays the default command');
});

test('the FTPS service mounts nothing from the host, only the certs volume [ARCH-108]', () => {
  // The server runs as uid 1001. A file mounted from a checkout keeps the host's mode, and with a
  // strict umask (027) that user cannot read it, so FTPS would not start for anyone.
  const mounts = /\n {4}volumes:\n((?: {6}- .*\n)+)/.exec(serviceBlock('klipgard-ftps'))?.[1].trim().split('\n').map((l) => l.trim());
  assert.deepEqual(mounts, ['- certs:/certs:ro']);
});
