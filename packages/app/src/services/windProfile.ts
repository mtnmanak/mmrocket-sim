import { KERNEL_WIND_FROM_RAD, type WindLevel } from '@online-openrocket/engine';

/** AGL metres, m/s, and FROM radians clockwise relative to the surface wind. */
export type RelativeWindLevel = WindLevel & {
  /** Saved only while an edited surface is calm, so zero cannot erase its shape. */
  calmSpeedRatio?: number;
};
export type WindProfileSource =
  | { kind: 'open-meteo'; place: string; validUnix: number; surfaceFromDeg: number }
  | { kind: 'ork' };

export interface WindProfileConditions {
  windLevels?: readonly RelativeWindLevel[];
  windProfileSource?: WindProfileSource;
}

/** Preserve precision inside a turn, including an exact zero. */
export function relativeWindDirection(rad: number): number {
  const r = rad % (2 * Math.PI);
  return r > Math.PI ? r - 2 * Math.PI : r <= -Math.PI ? r + 2 * Math.PI : r;
}

/** Register: Winds aloft in the app (Eric's weather item 5). Rotate the
 * surface to the kernel's fixed east wind so Rod aim keeps its pad meaning. */
export function kernelWindProfile(l: WindProfileConditions) {
  return l.windLevels?.length ? {
    windAltitudeReference: 'AGL' as const,
    windLevels: l.windLevels.map((v) => ({ altitude: v.altitude, speed: v.speed,
      direction: KERNEL_WIND_FROM_RAD + v.direction,
      ...(v.standardDeviation !== undefined ? { standardDeviation: v.standardDeviation } : {}) })),
  } : {};
}

export function scaleWindSigma(surfaceSigma: number, speed: number, surfaceSpeed: number): number {
  return surfaceSigma === 0 ? 0 : isCalmWind(surfaceSpeed) ? surfaceSigma : surfaceSigma * (speed / surfaceSpeed);
}

/** Vector cancellation leaves roundoff even when opposing winds cancel at the pad. */
export function isCalmWind(speed: number): boolean {
  return Math.abs(speed) < 1e-9;
}

/** The kernel clamps outside the profile and interpolates wind vectors at the pad. */
export function profileSurface(levels: readonly RelativeWindLevel[]) {
  const sorted = [...levels].sort((a, b) => a.altitude - b.altitude);
  const lo = sorted.filter((l) => l.altitude <= 0).pop() ?? sorted[0]!;
  const hi = sorted.find((l) => l.altitude >= 0) ?? sorted[sorted.length - 1]!;
  // A clamped endpoint (including an exact pad row) already has its magnitude
  // and bearing. Rebuilding them with trig loses orientation-dependent low bits.
  if (lo === hi) return { windAverage: lo.speed, windStdDev: lo.standardDeviation ?? 0, direction: lo.direction };
  const f = hi.altitude > lo.altitude ? -lo.altitude / (hi.altitude - lo.altitude) : 0;
  const x = lo.speed * Math.sin(lo.direction) * (1 - f) + hi.speed * Math.sin(hi.direction) * f;
  const y = lo.speed * Math.cos(lo.direction) * (1 - f) + hi.speed * Math.cos(hi.direction) * f;
  const windAverage = Math.hypot(x, y);
  return {
    windAverage,
    windStdDev: (lo.standardDeviation ?? 0) * (1 - f) + (hi.standardDeviation ?? 0) * f,
    direction: isCalmWind(windAverage) ? lo.direction : Math.atan2(x, y),
  };
}

/** A restored/replaced profile must use the surface fields that survive the write. */
export function reconcileProfileSurface<T extends WindProfileConditions & { windAverage: number; windStdDev: number }>(launch: T): T {
  if (!launch.windLevels?.length) return launch;
  const { windAverage, windStdDev } = profileSurface(launch.windLevels);
  const surface = { windAverage, windStdDev };
  // Import samples absolute bearings; restoration samples relative bearings.
  // Roundoff is not a manual edit: preserve saved levels verbatim, including
  // desktop turbulence that need not follow constant intensity.
  for (const key of ['windAverage', 'windStdDev'] as const) {
    if (Math.abs(surface[key] - launch[key]) <= 1e-9 * Math.max(1, Math.abs(surface[key]), Math.abs(launch[key]))) {
      surface[key] = launch[key];
    }
  }
  const unchanged = surface.windAverage === launch.windAverage && surface.windStdDev === launch.windStdDev;
  return unchanged ? launch : editProfileSurface({ ...launch, ...surface }, launch);
}

/** Editing the surface fields keeps the speed ratios and the chosen intensity. */
export function editProfileSurface<T extends WindProfileConditions & { windAverage: number; windStdDev: number }>(before: T, after: T): T {
  if (!before.windLevels?.length || (before.windAverage === after.windAverage && before.windStdDev === after.windStdDev)) return after;
  const padSpeedChanged = before.windAverage !== after.windAverage;
  const calm = isCalmWind(before.windAverage);
  const retained = calm && before.windLevels.every((l) => Number.isFinite(l.calmSpeedRatio) && l.calmSpeedRatio! >= 0);
  const levels = [...before.windLevels].sort((a, b) => a.altitude - b.altitude).map((l, i) => {
    const speed = retained ? l.calmSpeedRatio! * after.windAverage
      : calm ? (padSpeedChanged && i === 0 && l.altitude >= 0 ? after.windAverage : l.speed)
      : l.speed * (after.windAverage / before.windAverage);
    const next = { ...l, speed, standardDeviation: scaleWindSigma(after.windStdDev, speed, after.windAverage) };
    // NumField commits each valid keystroke (including the 0 in 0.5).
    // Keep ratios in the profile itself: autosave, receipts and Clear/Undo
    // must retain them even if the field unmounts while the wind is zero.
    if (isCalmWind(after.windAverage) && (!calm || retained)) {
      next.calmSpeedRatio = retained ? l.calmSpeedRatio : l.speed / before.windAverage;
    } else delete next.calmSpeedRatio;
    return next;
  });
  // A desktop MSL profile can straddle a calm pad with opposing winds.
  // Changing σ must leave those winds alone. Setting a nonzero surface wind
  // needs a pad level; changing a below-ground row would also turn Rod aim.
  if (calm && !retained && padSpeedChanged && levels[0]!.altitude < 0) {
    const aboveAndBelow = levels.filter((l) => l.altitude !== 0);
    aboveAndBelow.push({ altitude: 0, speed: after.windAverage, direction: 0, standardDeviation: after.windStdDev });
    return { ...after, windLevels: aboveAndBelow.sort((a, b) => a.altitude - b.altitude) };
  }
  // Below-pad desktop levels may veer: their interpolated speed magnitudes
  // exceed the pad's vector speed. Normalize sigma to its actual pad value.
  const surfaceSigma = profileSurface(levels).windStdDev;
  if (surfaceSigma > 0 && surfaceSigma !== after.windStdDev) {
    for (const l of levels) l.standardDeviation *= after.windStdDev / surfaceSigma;
  }
  return { ...after, windLevels: levels };
}

export function validWindProfileSource(x: unknown): x is WindProfileSource {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as WindProfileSource;
  return s.kind === 'ork' || (s.kind === 'open-meteo' && typeof s.place === 'string'
    && Number.isFinite(s.validUnix) && Number.isFinite(s.surfaceFromDeg));
}

/** Used for stored weather receipts as well as imported app metadata. */
export function validWindLevels(x: unknown): x is RelativeWindLevel[] {
  if (!Array.isArray(x)) return false;
  const heights = new Set<number>();
  return x.every((v: unknown) => {
    if (typeof v !== 'object' || v === null) return false;
    const l = v as RelativeWindLevel;
    if (![l.altitude, l.speed, l.direction].every((n) => typeof n === 'number' && Number.isFinite(n))
      || l.speed < 0 || (l.standardDeviation !== undefined
        && (!Number.isFinite(l.standardDeviation) || l.standardDeviation < 0))
      || (l.calmSpeedRatio !== undefined && (!Number.isFinite(l.calmSpeedRatio) || l.calmSpeedRatio < 0))
      || heights.has(l.altitude)) return false;
    heights.add(l.altitude);
    return true;
  });
}

export function windProfileSummary(levels: readonly RelativeWindLevel[]): string {
  const top = Math.max(...levels.map((l) => l.altitude));
  return `${levels.length} levels to ${Math.round(top / 0.3048).toLocaleString('en-US')} ft (${Math.round(top).toLocaleString('en-US')} m) above ground`;
}

export function windProfileSaveNotes(l: WindProfileConditions, format: '.rkt' | '.CDX1'): string[] {
  return l.windLevels?.length ? [`Winds aloft are not kept in ${format} files.`] : [];
}
