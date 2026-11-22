// The address cameras use to reach this machine [ARCH-107, ARCH-108, ARCH-109, ARCH-110].
//
// docker/ftp-host.sh resolves it from FTP_HOST or, when that is empty, from
// PUBLIC_URL. The `init-certs` service runs it at every start, and the FTP
// server's entrypoint, docker/ftps-entrypoint.sh, hands the result to the server.
//
//   node --test 'scripts/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER = path.join(ROOT, 'docker/ftp-host.sh');
const ENTRYPOINT = path.join(ROOT, 'docker/ftps-entrypoint.sh');

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocn-ftp-host-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Runs docker/ftp-host.sh with only the two settings it reads in its environment. */
function resolve({ ftpHost, publicUrl }) {
  const env = { PATH: process.env.PATH };
  if (ftpHost !== undefined) env.FTP_HOST = ftpHost;
  if (publicUrl !== undefined) env.PUBLIC_URL = publicUrl;
  const r = spawnSync('sh', [RESOLVER], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ── the resolver ───────────────────────────────────────────────────────────

test('[ARCH-108] an FTP_HOST that is set is used as it is, whatever PUBLIC_URL says', () => {
  for (const [ftpHost, publicUrl] of [
    ['192.168.1.10', 'http://192.168.1.10:8080'],
    ['10.0.0.7', 'https://clips.example.com'],
    ['ftp.example.org', 'https://clips.example.com'],
    ['192.168.1.10', undefined],
  ]) {
    const r = resolve({ ftpHost, publicUrl });
    assert.equal(r.code, 0, `${ftpHost} / ${publicUrl}: ${r.err}`);
    assert.equal(r.out, `${ftpHost}\n`);
    assert.equal(r.err, '');
  }
});

test('[ARCH-108] with FTP_HOST empty, the camera address is the IPv4 host of PUBLIC_URL', () => {
  for (const [publicUrl, host] of [
    ['http://192.168.1.10:8080', '192.168.1.10'],
    ['http://192.168.1.10', '192.168.1.10'],
    ['http://192.168.1.10:8080/', '192.168.1.10'],
    ['http://192.168.1.10:8080/clips?a=1#b', '192.168.1.10'],
    ['https://10.0.0.5', '10.0.0.5'],
    ['http://0.0.0.1:1', '0.0.0.1'], // 0 is a valid number
    ['http://255.255.255.255:8080', '255.255.255.255'], // so is 255
    ['http://100.64.0.9:8080', '100.64.0.9'],
  ]) {
    for (const ftpHost of ['', undefined]) { // a setting that is empty, and one that is missing
      const r = resolve({ ftpHost, publicUrl });
      assert.equal(r.code, 0, `${publicUrl}: ${r.err}`);
      assert.equal(r.out, `${host}\n`, publicUrl);
      assert.equal(r.err, '', publicUrl);
    }
  }
});

test('[ARCH-109] [ARCH-110] with FTP_HOST empty, a PUBLIC_URL without an IPv4 host stops the start and names FTP_HOST', () => {
  for (const publicUrl of [
    'https://clips.example.com',
    'https://clips.example.com/',
    'http://nas.local:8080',
    'http://localhost:8080',
    'http://user:secret@192.168.1.10:8080', // user information
    'http://192.168.1.10@clips.example.com', // looks like an address, is not the host
    'http://[::1]:8080', // IPv6
    'http://[fd00::10]:8080',
    'http://192.168.001.010:8080', // leading zeros
    'http://192.168.1.256:8080', // a number above 255
    'http://192.168.1:8080', // three numbers
    'http://192.168.1.10.5:8080', // five numbers
    'http://192.168.1.x:8080',
    'http://.1.2.3:8080',
    'http://1.2.3.:8080',
    'http://1..2.3:8080',
    'http://',
    'http://:8080',
    '192.168.1.10:8080', // no scheme
    'ftp://192.168.1.10',
    '',
    undefined,
  ]) {
    const r = resolve({ ftpHost: '', publicUrl });
    assert.equal(r.code, 1, `${publicUrl}`);
    assert.equal(r.out, '', `${publicUrl}: nothing may be printed as an address`);
    assert.match(r.err, /FTP_HOST/, `${publicUrl}`);
    assert.match(r.err, /\.env/, `${publicUrl}`);
    assert.ok(!r.err.includes('secret'), `${publicUrl}: the message must not repeat the URL`);
  }
});

// ── the FTP server's entrypoint ────────────────────────────────────────────

/**
 * Runs docker/ftps-entrypoint.sh with `sh -c` as the "server": it reports the
 * address it was started with and its own process id. `hostFile` is what
 * init-certs left in the certs volume: text, or null for no file at all.
 */
function startServer({ pasvUrl, hostFile }) {
  return withTempDir((dir) => {
    const env = { PATH: process.env.PATH, FTP_HOST_FILE: path.join(dir, 'ftp-host') };
    if (pasvUrl !== undefined) env.FTP_PASV_URL = pasvUrl;
    if (hostFile !== null) writeFileSync(env.FTP_HOST_FILE, hostFile);
    const r = spawnSync('sh', [ENTRYPOINT, 'sh', '-c', 'echo "pasv=$FTP_PASV_URL pid=$$"'], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr, pid: r.pid };
  });
}

test('[ARCH-108] the entrypoint keeps an FTP_PASV_URL that is set', () => {
  const r = startServer({ pasvUrl: '203.0.113.7', hostFile: '192.168.1.10\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.trim(), /^pasv=203\.0\.113\.7 pid=\d+$/);
});

test('[ARCH-108] with FTP_PASV_URL empty, the entrypoint uses the address that init-certs resolved', () => {
  for (const pasvUrl of ['', undefined]) {
    const r = startServer({ pasvUrl, hostFile: '192.168.1.10\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out.trim(), /^pasv=192\.168\.1\.10 pid=\d+$/);
  }
});

test('the entrypoint becomes the server, so the server is the main process and gets the stop signal', () => {
  const r = startServer({ pasvUrl: '192.168.1.10', hostFile: null });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `pasv=192.168.1.10 pid=${r.pid}`);
});

test('[ARCH-109] the entrypoint does not start the server without a camera address', () => {
  for (const hostFile of ['', '\n', null]) {
    const r = startServer({ pasvUrl: '', hostFile });
    assert.notEqual(r.code, 0, JSON.stringify(hostFile));
    assert.equal(r.out, '', `${JSON.stringify(hostFile)}: the server must not start`);
    assert.match(r.err, /FTP_HOST|camera address/i, JSON.stringify(hostFile));
  }
});
