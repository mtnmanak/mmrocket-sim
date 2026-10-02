import { distanceM, ELEVATION_AGREE_M } from './openMeteo.js';

export interface CoordinateSite { latitudeDeg: number; longitudeDeg: number }
export interface FileLongitudeCheck {
  opened: CoordinateSite;
  sibling: CoordinateSite;
  siblingCount: number;
  distanceKm: number;
  flippedDistanceKm: number;
}

function usableSite(site: { latitudeDeg?: number; longitudeDeg?: number | null }): site is CoordinateSite {
  return typeof site.latitudeDeg === 'number' && Number.isFinite(site.latitudeDeg)
    && Math.abs(site.latitudeDeg) <= 90 && typeof site.longitudeDeg === 'number'
    && Number.isFinite(site.longitudeDeg) && Math.abs(site.longitudeDeg) >= 5
    && Math.abs(site.longitudeDeg) <= 180;
}

/** Offline evidence only: never substitutes a sibling's coordinates for the file's. */
export function checkFileLongitude(
  opened: { latitudeDeg?: number; longitudeDeg?: number | null }, siblings: CoordinateSite[],
): FileLongitudeCheck | undefined {
  if (!usableSite(opened) || opened.longitudeDeg === -80.6) return undefined;
  for (const sibling of siblings) {
    // Desktop's default pair and legacy blank longitudes are not site evidence.
    if (!usableSite(sibling) || sibling.longitudeDeg === -80.6) continue;
    if (opened.longitudeDeg * sibling.longitudeDeg >= 0) continue;
    const distanceKm = distanceM(opened.latitudeDeg, opened.longitudeDeg, sibling.latitudeDeg, sibling.longitudeDeg) / 1000;
    const flippedDistanceKm = distanceM(opened.latitudeDeg, -opened.longitudeDeg, sibling.latitudeDeg, sibling.longitudeDeg) / 1000;
    if (distanceKm <= 2000 || flippedDistanceKm > 300) continue;
    return {
      opened, sibling, distanceKm, flippedDistanceKm,
      siblingCount: siblings.filter((s) => s.latitudeDeg === sibling.latitudeDeg && s.longitudeDeg === sibling.longitudeDeg).length,
    };
  }
  return undefined;
}

export function fileLongitudeNote(check: FileLongitudeCheck, simulationName: string): string {
  const { opened, sibling, siblingCount, distanceKm, flippedDistanceKm } = check;
  const side = (lon: number) => lon < 0 ? 'west' : 'east';
  const km = (n: number) => (Math.round(n / 100) * 100).toLocaleString('en-US');
  return `This file states two sites that look like one site with the longitude’s sign flipped: the opened simulation “${simulationName}”`
    + ` is at ${opened.latitudeDeg}, ${opened.longitudeDeg} (${side(opened.longitudeDeg)}); ${siblingCount} of its other simulations`
    + ` ${siblingCount === 1 ? 'is' : 'are'} at ${sibling.latitudeDeg}, ${sibling.longitudeDeg} (${side(sibling.longitudeDeg)}),`
    + ` ${km(distanceKm)} km away. With the sign flipped it is ${km(flippedDistanceKm)} km from them. The file’s value was kept.`;
}

/** Run only against the rounded fix chosen by the user's location-button click. */
export function deviceMirrorsDesign(
  design: { latitudeDeg?: number; longitudeDeg?: number | null }, device: CoordinateSite,
): boolean {
  return usableSite(design) && usableSite(device) && design.longitudeDeg !== -80.6
    && Math.abs(design.latitudeDeg - device.latitudeDeg) <= 0.5
    && Math.abs(design.longitudeDeg + device.longitudeDeg) <= 0.5;
}

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
