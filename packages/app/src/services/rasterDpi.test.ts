import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { withDpi } from './rasterDpi.js';

/**
 * The PNG and JPG fin templates carry their 300 dpi in the file, so an import
 * places them at true scale. The checks below read the bytes with their own
 * parser and node's own CRC-32, not the writer's.
 */

const be32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]): number[] => {
  const body = [...ascii(type), ...data];
  return [...be32(data.length), ...body, ...be32(zlibCrc32(Uint8Array.from(body)))];
};
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A 1 x 1 PNG's chunk layout — IHDR, optional extras, IDAT, IEND. */
const png = (...extra: number[][]): Uint8Array => Uint8Array.from([
  ...SIG,
  ...chunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]),
  ...extra.flat(),
  ...chunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]),
  ...chunk('IEND', []),
]);

interface Chunk { type: string; data: Uint8Array; crcOk: boolean }
const chunks = (d: Uint8Array): Chunk[] => {
  expect([...d.subarray(0, 8)]).toEqual(SIG);
  const out: Chunk[] = [];
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let o = 8; o < d.length;) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...d.subarray(o + 4, o + 8));
    const data = d.subarray(o + 8, o + 8 + len);
    const crc = view.getUint32(o + 8 + len);
    out.push({ type, data, crcOk: crc === zlibCrc32(d.subarray(o + 4, o + 8 + len)) });
    o += 12 + len;
  }
  return out;
};

describe('withDpi — PNG', () => {
  it('adds one pHYs right after IHDR: 11811 px per metre (300 dpi) on both axes, unit metre', () => {
    const out = withDpi(png(), 'png', 300);
    const cs = chunks(out);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(cs.every((c) => c.crcOk)).toBe(true);
    const phys = new DataView(cs[1]!.data.buffer, cs[1]!.data.byteOffset, 9);
    expect(phys.getUint32(0)).toBe(11811);
    expect(phys.getUint32(4)).toBe(11811);
    expect(phys.getUint8(8)).toBe(1);
    // 11811 px/m back to dpi is 300.0 to a hundredth.
    expect(11811 * 0.0254).toBeCloseTo(300, 1);
  });

  it('replaces a pHYs already there instead of writing a second', () => {
    const old = chunk('pHYs', [...be32(2835), ...be32(2835), 1]); // 72 dpi
    const cs = chunks(withDpi(png(old), 'png', 300));
    expect(cs.filter((c) => c.type === 'pHYs')).toHaveLength(1);
    expect(new DataView(cs[1]!.data.buffer, cs[1]!.data.byteOffset).getUint32(0)).toBe(11811);
  });

  it('keeps every other chunk byte for byte', () => {
    const text = chunk('tEXt', ascii('Software\0MMRocket Sim'));
    const before = chunks(png(text));
    const after = chunks(withDpi(png(text), 'png', 300)).filter((c) => c.type !== 'pHYs');
    expect(after.map((c) => [c.type, [...c.data]])).toEqual(before.map((c) => [c.type, [...c.data]]));
  });

  it('leaves bytes that are not a PNG alone', () => {
    const junk = Uint8Array.from([1, 2, 3, 4, 5]);
    expect(withDpi(junk, 'png', 300)).toBe(junk);
  });
});

describe('withDpi — JPEG', () => {
  const JFIF = [0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const body = [0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9];

  it('sets the JFIF density to 300 x 300 dots per inch', () => {
    const src = Uint8Array.from([0xff, 0xd8, ...JFIF, ...body]);
    const out = withDpi(src, 'jpeg', 300);
    expect(out.length).toBe(src.length);
    expect(out[13]).toBe(1);                       // units: dots per inch
    expect((out[14]! << 8) | out[15]!).toBe(300);
    expect((out[16]! << 8) | out[17]!).toBe(300);
    // Nothing else moved, and the source is not mutated.
    expect([...out.subarray(18)]).toEqual([...src.subarray(18)]);
    expect(src[13]).toBe(0);
  });

  it('inserts a JFIF header with the density when the file has none', () => {
    const src = Uint8Array.from([0xff, 0xd8, ...body]);
    const out = withDpi(src, 'jpeg', 300);
    expect([...out.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(String.fromCharCode(...out.subarray(6, 10))).toBe('JFIF');
    expect(out[13]).toBe(1);
    expect((out[14]! << 8) | out[15]!).toBe(300);
    expect([...out.subarray(20)]).toEqual(body);
  });

  it('leaves bytes that are not a JPEG alone', () => {
    const junk = Uint8Array.from([0, 1, 2, 3]);
    expect(withDpi(junk, 'jpeg', 300)).toBe(junk);
  });
});
