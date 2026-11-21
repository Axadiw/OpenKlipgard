// @vitest-environment node
import { describe, expect, it } from 'vitest';
import nginxConf from '../../nginx.conf?raw';

// [ARCH-105] The web app nginx does not send its version number.

describe('nginx.conf [ARCH-105]', () => {
  it('turns server_tokens off', () => {
    expect(nginxConf).toMatch(/^\s*server_tokens\s+off;/m);
  });
});
