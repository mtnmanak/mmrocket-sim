import { crc32 } from './zipMember.js';

/** Shared size verdict: jigs refuse it; fin templates add context only if export fails. */
export function rasterLimitProblem(width: number, height: number): string | null {
  return width * height > 16_000_000 || Math.max(width, height) > 8192
    ? 'too large for a 300 dpi image (limits: 16 million pixels in total, 8192 pixels on either side)'
    : null;
}

/** Preserve 300 dpi without exhausting canvas memory or silently shrinking a print. */
export function assertRasterizable(width: number, height: number): void {
  const problem = rasterLimitProblem(width, height);
  if (problem) throw new Error(problem);
}

/**
 * Stamp a print resolution into a PNG or JPEG the canvas encoded.
 *
 * A canvas writes no resolution of its own: Chrome's PNG has no pHYs chunk and
 * its JPEG's JFIF header says "aspect ratio only", so every reader falls back
 * to its own guess (72 or 96 dpi) and a 1:1 fin template rendered at 300 dpi
 * imports at three or four times its size. With the resolution in the file, a
 * CAD import, a print dialog or an image editor places it at true scale. The
 * calibration ruler is still drawn, for the reader that ignores both fields.
 *
 * Anything that is not the format it claims to be is returned unchanged.
 */
export function withDpi(bytes: Uint8Array, format: 'png' | 'jpeg', dpi: number): Uint8Array {
  return format === 'png' ? pngWithDpi(bytes, dpi) : jpegWithDpi(bytes, dpi);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0;
const put32 = (d: Uint8Array, o: number, v: number): void => {
  d[o] = (v >>> 24) & 255; d[o + 1] = (v >>> 16) & 255; d[o + 2] = (v >>> 8) & 255; d[o + 3] = v & 255;
};
const type4 = (d: Uint8Array, o: number): string => String.fromCharCode(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);

/**
 * PNG: one pHYs chunk (pixels per METRE, unit byte 1) straight after IHDR,
 * where the spec requires it to sit before IDAT; any pHYs already present is
 * dropped so the file never carries two.
 */
function pngWithDpi(d: Uint8Array, dpi: number): Uint8Array {
  if (d.length < 33 || PNG_SIG.some((b, i) => d[i] !== b) || type4(d, 12) !== 'IHDR') return d;
  const ihdrEnd = 8 + 12 + u32(d, 8);
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  put32(chunk, 0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  put32(chunk, 8, ppm);
  put32(chunk, 12, ppm);
  chunk[16] = 1; // unit: metre
  put32(chunk, 17, crc32(chunk.subarray(4, 17)));
  const parts: Uint8Array[] = [d.subarray(0, ihdrEnd), chunk];
  for (let o = ihdrEnd; o + 12 <= d.length;) {
    const end = o + 12 + u32(d, o);
    if (end > d.length) return d; // truncated: leave it alone
    if (type4(d, o + 4) !== 'pHYs') parts.push(d.subarray(o, end));
    o = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * JPEG: the JFIF APP0 header's density fields, units 1 = dots per inch. The
 * canvas writes a JFIF header with units 0 (aspect ratio only); one without a
 * header at all gets one inserted after SOI.
 */
function jpegWithDpi(d: Uint8Array, dpi: number): Uint8Array {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return d;
  const v = Math.max(1, Math.min(65535, Math.round(dpi)));
  const isJfif = d.length >= 18 && d[2] === 0xff && d[3] === 0xe0
    && String.fromCharCode(d[6]!, d[7]!, d[8]!, d[9]!) === 'JFIF' && d[10] === 0;
  if (isJfif) {
    const out = d.slice();
    out[13] = 1;
    out[14] = v >> 8; out[15] = v & 255;
    out[16] = v >> 8; out[17] = v & 255;
    return out;
  }
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x01, v >> 8, v & 255, v >> 8, v & 255, 0x00, 0x00,
  ]);
  const out = new Uint8Array(d.length + app0.length);
  out.set(d.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(d.subarray(2), 2 + app0.length);
  return out;
}
