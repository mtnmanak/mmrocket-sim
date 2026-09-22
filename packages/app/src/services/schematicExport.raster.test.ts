// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { svgToImage } from './schematicExport.js';

/**
 * svgToImage SETTLES — it never leaves the ⬇ Image button waiting forever
 * (audit 2026-09-22).
 *
 * Its canvas work runs inside `img.onload`, an event callback outside the
 * promise executor, so a throw there rejected nothing and never reached the
 * caller's catch: the export hung and the button went dead. happy-dom's canvas
 * has no 2D context, which is the same null a browser hands back when it
 * refuses an oversized canvas — so it reproduces the real failure directly.
 */

/** An Image that "loads" on the next tick, whatever src it is given. */
class LoadingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 400;
  naturalHeight = 100;
  set src(_url: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

const realImage = globalThis.Image;
/** Resolves to 'hung' if `p` has not settled within `ms`. */
const settled = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([
    p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e })),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms)),
  ]);

let revoked: string[];

beforeEach(() => {
  (globalThis as { Image: unknown }).Image = LoadingImage;
  revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:svg-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
});

afterEach(() => {
  (globalThis as { Image: unknown }).Image = realImage;
  vi.restoreAllMocks();
});

describe('svgToImage — a failure inside onload rejects', () => {
  it('rejects, naming the refused canvas, when there is no 2D context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const out = await settled(svgToImage('<svg/>', 7680, 'png'));
    expect(out).not.toBe('hung');
    const err = (out as { err: unknown }).err;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('the browser refused a 7680 x 1920 px canvas');
    // ...and the object URL is released on the failure path too.
    expect(revoked).toEqual(['blob:svg-test']);
  });

  it('rejects when drawing itself throws', async () => {
    const ctx = { fillRect: () => {}, drawImage: () => { throw new Error('tainted'); } };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const out = await settled(svgToImage('<svg/>', 1920, 'jpeg'));
    expect((out as { err: Error }).err.message).toBe('tainted');
    expect(revoked).toEqual(['blob:svg-test']);
  });

  it('still resolves to the encoded image when nothing goes wrong', async () => {
    const ctx = { fillRect: () => {}, drawImage: () => {} };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const png = new Blob(['png'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((cb: BlobCallback) => { cb(png); });
    const out = await settled(svgToImage('<svg/>', 1920, 'png'));
    expect((out as { ok: Blob }).ok).toBe(png);
    expect(revoked).toEqual(['blob:svg-test']);
  });
});
