/**
 * WIND GUSTS σ FROM A FORECAST GUST (weather build, step 4).
 *
 * The kernel's turbulence is a standard deviation, σ, about the average wind;
 * no forecast states one. What a forecast does state is a GUST — Open-Meteo's
 * hourly `wind_gusts_10m`, the strongest 3-second gust in the hour before —
 * beside the average wind for that hour. A peak is a known multiple of σ above
 * the mean for a given averaging time, so:
 *
 *   σ ≈ (gust − mean) / 3.0
 *
 * 3.0 because the gust is an hourly MAXIMUM of 3-second gusts: over an hour
 * there are many independent gusts, and the largest sits about three standard
 * deviations out. (For a 10-minute mean the factor is nearer 2.5; using that
 * here would overstate σ by a fifth.) Good to about ±25 % — it is an estimate,
 * and the chip that offers it says so.
 *
 * Capped at the mean itself, the most desktop OpenRocket's own panel allows
 * (its Swing spinner's bound; the kernel alone clamps only at 0), so a file
 * saved with it opens in desktop unchanged. The raw figure is kept for the
 * intensity test, which is not affected by the cap.
 *
 * PURE and unit-free in the sense that matters: σ/mean is the same in any
 * speed unit, so a wind read in the wrong unit would sail through here. The
 * only guard against that is openMeteo.ts's `hourly_units` assertion.
 *
 * NEVER written by anything but a click on the chip that offers it: not on
 * render, not on fetch, not by the weather dialog's Apply, and never on the
 * Fly screen.
 */

/** Hourly maximum of the 3-second gust against the hour's mean wind at 10 m. */
export const GUST_PEAK_FACTOR = 3.0;

/**
 * Turbulence intensity (σ/mean) above which the gust is more likely thermals
 * or showers than steady turbulence — warned STRICTLY above.
 */
export const GUST_CONVECTIVE_INTENSITY = 0.30;

/** Open-Meteo states the gust to 0.1 m/s (measured 2026-09-22); a smaller excess is noise. */
export const GUST_RESOLUTION_MS = 0.1;

export type GustSigma =
  | { ok: false; reason: 'no-gust' | 'calm' | 'gust-not-above-mean' }
  | {
    ok: true;
    /** The σ offered (m/s): raw, rounded to 0.01, capped at the mean. */
    sigmaMs: number;
    /** (gust − mean) / 3, unrounded and uncapped. */
    rawSigmaMs: number;
    /** rawSigmaMs / mean — turbulence intensity, from the RAW σ. */
    intensity: number;
    capped: boolean;
    convective: boolean;
  };

export function sigmaFromGust(meanMs?: number | null, gustMs?: number | null): GustSigma {
  if (gustMs == null || !Number.isFinite(gustMs)) return { ok: false, reason: 'no-gust' };
  if (meanMs == null || !Number.isFinite(meanMs) || meanMs <= 0) return { ok: false, reason: 'calm' };
  // Compared in hundredths, not in floats: 2.5 − 2.4 is 0.10000000000000009,
  // which a plain `<= 0.1` would read as a gust above its own resolution.
  if (Math.round((gustMs - meanMs) * 100) <= Math.round(GUST_RESOLUTION_MS * 100)) {
    return { ok: false, reason: 'gust-not-above-mean' };
  }
  const raw = (gustMs - meanMs) / GUST_PEAK_FACTOR;
  const intensity = raw / meanMs;
  return {
    ok: true,
    rawSigmaMs: raw,
    intensity,
    capped: raw > meanMs,
    sigmaMs: Math.min(Math.round(raw * 100) / 100, meanMs),
    convective: intensity > GUST_CONVECTIVE_INTENSITY,
  };
}
