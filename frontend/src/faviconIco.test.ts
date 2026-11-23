// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';

// A Node Buffer: the web package has no @types/node, so it is untyped here.
const ico = readFileSync(new URL('../public/favicon.ico', import.meta.url));

describe('/favicon.ico', () => {
  it('[WEB-052] is a real icon file with 16, 32 and 48 px frames', () => {
    // ICONDIR: reserved word 0, type 1 (icon), then the number of frames.
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const frames: number = ico.readUInt16LE(4);
    // ICONDIRENTRY, 16 bytes each, starts with the width and the height; 0 would mean 256.
    const sizes = Array.from({ length: frames }, (_, i) => [ico[6 + 16 * i], ico[7 + 16 * i]]);
    expect(sizes.sort((a, b) => a[0] - b[0])).toEqual([[16, 16], [32, 32], [48, 48]]);
  });

  it('[WEB-052] is not the app shell: every frame is a PNG', () => {
    const frames: number = ico.readUInt16LE(4);
    for (let i = 0; i < frames; i++) {
      const at: number = ico.readUInt32LE(6 + 16 * i + 12);
      expect(Array.from(ico.subarray(at, at + 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
