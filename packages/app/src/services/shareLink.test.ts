import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeShareFragment, encodeShareFragment, hasSharePayload, shareLinkOpenFailure } from './shareLink.js';

// These tests run in vitest's node environment: Node ≥ 21.2 ships the same
// CompressionStream / DecompressionStream / Blob / Response / atob globals
// the browser code path uses, so nothing is mocked — if an environment ever
// lacks them, polyfill HERE (test-only), never in the service.
const missing = ['CompressionStream', 'DecompressionStream', 'Blob', 'Response', 'atob']
  .filter((g) => !(g in globalThis));
if (missing.length) {
  throw new Error(`share-link tests need globals this runtime lacks: ${missing.join(', ')}`);
}

/** A small but realistic .ork-shaped payload (repetitive, like real XML). */
const XML = `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.8"><rocket><name>Alpha “Ⅲ” — 3°</name>
<subcomponents>${'<bodytube><length>0.3</length><radius>0.0125</radius></bodytube>'.repeat(20)}
</subcomponents></rocket></openrocket>`;

describe('share-link codec', () => {
  it('round-trips XML exactly, non-ASCII included', async () => {
    const frag = await encodeShareFragment(XML);
    expect(await decodeShareFragment(frag)).toBe(XML);
  });

  it('produces a #d=1.<base64url> fragment that is URL-safe end to end', async () => {
    const frag = await encodeShareFragment(XML);
    expect(frag.startsWith('#d=1.')).toBe(true);
    // Everything after the version dot stays inside the base64url alphabet —
    // no '+', '/', '=', '&' or '#' to be mangled by URL parsers or chat apps.
    expect(frag.slice('#d=1.'.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hasSharePayload(frag)).toBe(true);
    expect(hasSharePayload('#other')).toBe(false);
  });

  it('actually compresses (repetitive XML shrinks well below plain base64)', async () => {
    const frag = await encodeShareFragment(XML);
    const uncompressed = btoa(unescape(encodeURIComponent(XML)));
    expect(frag.length).toBeLessThan(uncompressed.length / 2);
  });

  it('accepts the fragment with or without the leading #', async () => {
    const frag = await encodeShareFragment(XML);
    expect(await decodeShareFragment(frag.slice(1))).toBe(XML);
  });

  it('rejects a payload from a future format version with a clear message', async () => {
    await expect(decodeShareFragment('#d=9.AAAA')).rejects.toThrow(/newer version/);
  });

  it('rejects malformed payloads instead of returning garbage', async () => {
    await expect(decodeShareFragment('#d=')).rejects.toThrow();
    await expect(decodeShareFragment('#loaded=true')).rejects.toThrow();
    // Characters outside the base64url alphabet.
    await expect(decodeShareFragment('#d=1.!!not-base64!!')).rejects.toThrow();
    // Valid base64 of bytes that are not a deflate stream.
    await expect(decodeShareFragment('#d=1.AAAAAAAA')).rejects.toThrow();
  });

  it('rejects a truncated link (the chat-app failure mode)', async () => {
    const frag = await encodeShareFragment(XML);
    await expect(decodeShareFragment(frag.slice(0, Math.floor(frag.length / 2))))
      .rejects.toThrow();
  });

  it('aborts a decompression bomb at the inflated-size cap instead of materializing it', async () => {
    // A REAL crafted bomb: 32 MB of one repeated byte deflates to ~32 KB —
    // the same ~1000:1 ratio as the measured 49 KB → 12 MB attack fragment.
    const bomb = await encodeShareFragment('A'.repeat(32 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024); // it IS a plausible-size link
    await expect(decodeShareFragment(bomb)).rejects.toThrow(/expands past 4 MB/);
  });

  it('still round-trips a normal design under the bomb cap', async () => {
    // A realistic large design (~340 KB of XML) stays well inside the cap.
    const big = `<openrocket><rocket><name>Big</name><subcomponents>${
      '<bodytube><length>0.3</length><radius>0.0125</radius></bodytube>'.repeat(5000)
    }</subcomponents></rocket></openrocket>`;
    expect(await decodeShareFragment(await encodeShareFragment(big))).toBe(big);
  });
});

describe('a browser that cannot unpack a share link (audit 2026-09-22)', () => {
  // An older iPad (Safari before 16.4) has no DecompressionStream at all, and
  // a Chromium before 103 has one without 'deflate-raw'. Every link then
  // failed inside the inflater and was reported as "damaged or cut short —
  // ask for the link again", sending the user back for a link that fails the
  // same way.
  const REAL = globalThis.DecompressionStream;
  afterEach(() => { vi.unstubAllGlobals(); });

  it('says which browser is needed when DecompressionStream is missing', async () => {
    const frag = await encodeShareFragment(XML);
    vi.stubGlobal('DecompressionStream', undefined);
    const err = await decodeShareFragment(frag).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const note = shareLinkOpenFailure(err);
    expect(note).toMatch(/this browser/i);
    expect(note).toMatch(/Safari 16\.4/);
    expect(note).not.toMatch(/damaged|ask for the link again/i);
  });

  it('and when it has one without deflate-raw', async () => {
    const frag = await encodeShareFragment(XML);
    vi.stubGlobal('DecompressionStream', class {
      constructor(format: string) {
        if (format !== 'gzip' && format !== 'deflate') {
          throw new TypeError(`Failed to construct 'DecompressionStream': Unsupported format '${format}'`);
        }
        return new REAL(format as CompressionFormat);
      }
    });
    const note = shareLinkOpenFailure(await decodeShareFragment(frag).then(() => null, (e: unknown) => e));
    expect(note).toMatch(/this browser/i);
    expect(note).not.toMatch(/damaged/i);
  });

  it('a genuinely damaged link is still called damaged', async () => {
    const frag = await encodeShareFragment(XML);
    const err = await decodeShareFragment(frag.slice(0, Math.floor(frag.length / 2))).then(() => null, (e: unknown) => e);
    expect(shareLinkOpenFailure(err)).toMatch(/damaged or cut short/);
  });
});
