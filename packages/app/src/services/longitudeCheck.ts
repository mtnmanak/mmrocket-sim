import { ELEVATION_AGREE_M } from './openMeteo.js';

/**
 * Register, 24 Sep 2026, Tier 0 row 44: B-lite uses terrain disagreement
 * AND the browser offset, never either alone. No mirrored request is needed.
 */
export function likelyFlippedLongitude({ designSite, longitudeDeg, siteM, demM, utcOffsetHours }: {
  designSite: boolean;
  longitudeDeg: number | null | undefined;
  siteM: number;
  demM: number | null;
  /** East-positive UTC offset (the opposite sign to Date.getTimezoneOffset). */
  utcOffsetHours: number;
}): boolean {
  if (!designSite || longitudeDeg == null || !Number.isFinite(longitudeDeg)
      || Math.abs(longitudeDeg) < 5 || Math.abs(longitudeDeg) > 180 || longitudeDeg === -80.6) return false;
  if (!Number.isFinite(siteM) || siteM <= 0 || demM === null || !Number.isFinite(demM)
      || Math.abs(demM - siteM) <= ELEVATION_AGREE_M || !Number.isFinite(utcOffsetHours)) return false;
  const hoursAway = (longitude: number) => {
    const delta = Math.abs(utcOffsetHours - longitude / 15) % 24;
    return Math.min(delta, 24 - delta);
  };
  // Near Greenwich/the date line both signs may fit. Ask only when the current one does not.
  return hoursAway(-longitudeDeg) <= 3 && hoursAway(longitudeDeg) > 3;
}
