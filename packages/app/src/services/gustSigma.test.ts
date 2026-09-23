import { describe, expect, it } from 'vitest';
import { GUST_CONVECTIVE_INTENSITY, GUST_PEAK_FACTOR, sigmaFromGust } from './gustSigma.js';

/**
 * σ from a forecast gust (weather build, step 4): σ ≈ (gust − mean)/3.0,
 * rounded to 0.01 m/s and capped at the mean; a convective warning strictly
 * above an intensity of 0.30, read from the RAW σ. Worked cases from the spec,
 * the edges included.
 */
describe('sigmaFromGust', () => {
  const ok = (mean: number, gust: number) => {
    const r = sigmaFromGust(mean, gust);
    if (!r.ok) throw new Error(`${mean}/${gust}: ${r.reason}`);
    return r;
  };

  it('the worked example: 5 m/s gusting 11 is σ 2.00, intensity 0.40, convective', () => {
    expect(ok(5, 11)).toEqual({ ok: true, sigmaMs: 2, rawSigmaMs: 2, intensity: 0.4, capped: false, convective: true });
  });

  it('warns strictly ABOVE 0.30 — exactly 0.30 is not convective', () => {
    expect(ok(5, 9.5)).toMatchObject({ sigmaMs: 1.5, convective: false });
    expect(ok(5, 9.5).intensity).toBeCloseTo(0.3, 12);
    // In gust space 0.3 × 3 is 0.8999999999999999; the test is on σ/mean.
    expect(ok(10, 19)).toMatchObject({ sigmaMs: 3, convective: false });
    expect(ok(5, 9.53)).toMatchObject({ sigmaMs: 1.51, convective: true });
    expect(ok(5, 9.53).intensity).toBeCloseTo(0.302, 12);
    expect(ok(3.7, 7.0)).toMatchObject({ sigmaMs: 1.1, convective: false });
    expect(ok(3.7, 7.0).intensity).toBeCloseTo(0.2973, 4);
    expect(GUST_CONVECTIVE_INTENSITY).toBe(0.3);
    expect(GUST_PEAK_FACTOR).toBe(3);
  });

  it('offers nothing for a gust at or below the mean, calm air, or no gust', () => {
    expect(sigmaFromGust(5, 5)).toEqual({ ok: false, reason: 'gust-not-above-mean' });
    expect(sigmaFromGust(5, 4)).toEqual({ ok: false, reason: 'gust-not-above-mean' });
    expect(sigmaFromGust(0, 3)).toEqual({ ok: false, reason: 'calm' });
    expect(sigmaFromGust(-1, 3)).toEqual({ ok: false, reason: 'calm' });
    for (const g of [null, undefined, NaN]) expect(sigmaFromGust(5, g)).toEqual({ ok: false, reason: 'no-gust' });
  });

  it('treats a gust within Open-Meteo’s 0.1 m/s resolution as no gust, in hundredths not floats', () => {
    // The live 03:00 row that motivated the floor.
    expect(sigmaFromGust(2.48, 2.5)).toEqual({ ok: false, reason: 'gust-not-above-mean' });
    // 2.5 − 2.4 is 0.10000000000000009 in binary: still the floor.
    expect(sigmaFromGust(2.4, 2.5)).toEqual({ ok: false, reason: 'gust-not-above-mean' });
    expect(ok(2.47, 2.7).sigmaMs).toBe(0.08);
  });

  it('caps σ at the mean — the most desktop’s panel allows — and says so', () => {
    const r = ok(1, 6);
    expect(r.sigmaMs).toBe(1);
    expect(r.capped).toBe(true);
    expect(r.rawSigmaMs).toBeCloseTo(1.6667, 4);
    expect(r.intensity).toBeCloseTo(1.6667, 4);
    // Exactly the mean is not capped.
    expect(ok(1, 4)).toMatchObject({ sigmaMs: 1, rawSigmaMs: 1, capped: false });
    expect(ok(1.73, 5.2)).toMatchObject({ sigmaMs: 1.16, capped: false });
    expect(ok(1.73, 5.2).intensity).toBeCloseTo(0.669, 3);
  });
});
