import type { ComponentNode, FlightResult, FlightSeries, RocketTree } from '@online-openrocket/engine';
import { boosterBranches } from '@online-openrocket/engine';
import { normalizeFlightAdvisories, type FlightAdvisories } from '../prefs/flightAdvisories.js';
import { fmtSi, INITIAL_UNITS, siToUi, type UnitSelection } from '../prefs/units.js';
import { flownDeployEvent } from '../tree/deployEvent.js';

// N004: NAR Model Rocket Safety Code §9 (Launch Site), NAR High Power Rocket
// Safety Code §9 (Flight Safety): no launch above 20 mph. Tripoli Unified
// Safety Code §9-3: no launch when sustained surface winds exceed 20 MPH.
// https://www.nar.org/ModelRocketSafetyCode
// https://www.nar.org/content.aspx?page_id=22
// https://www.tripoli.org/safetycode (checked 2026-10-13)
export const SURFACE_WIND_LIMIT_MS = 20 * 0.44704;

export function groundWindAdvice(wind: number, units: UnitSelection): string | null {
  if (!Number.isFinite(wind) || wind <= SURFACE_WIND_LIMIT_MS) return null;
  const limit = siToUi('windspeed', units.windspeed, SURFACE_WIND_LIMIT_MS);
  let speed = fmtSi('windspeed', units.windspeed, wind);
  if (Number(speed) <= limit) speed = fmtSi('windspeed', units.windspeed, wind, 2);
  // N004: finite display precision must not turn an exceedance into equality.
  const measurement = Number(speed) > limit
    ? `Surface wind average ${speed} ${units.windspeed} exceeds 20 mph (8.9408 m/s). `
    : 'Surface wind average is just above 20 mph (8.9408 m/s). ';
  return measurement
    + 'NAR model and high-power codes limit launch wind to 20 mph; Tripoli applies this limit to sustained surface wind. '
    + 'Wind can carry the rocket outside the recovery area. Check wind at the pad, including gusts; the app does not block Launch.';
}

/** N003: mirror DeploymentConfiguration.EJECTION's assembly ownership (#2092).
 * Pods, parallel stages and axial stages have separate ejection-charge spaces. */
export function recoveryAssembly(tree: RocketTree, id: string): ComponentNode[] {
  let found: ComponentNode | undefined;
  const walk = (nodes: ComponentNode[], assembly?: ComponentNode): void => {
    for (const node of nodes) {
      const owner = ['stage', 'parallelstage', 'podset'].includes(node.type) ? node : assembly;
      if (node.id === id) found = owner;
      walk(node.children ?? [], owner);
    }
  };
  walk(tree.components);
  return found ? [found] : [];
}

export function zeroDelayRecoveryAdvice(
  tree: RocketTree, mountId: string, delay: number, autoDelay = false,
): string | null {
  if (delay !== 0 || autoDelay) return null;
  const devices: string[] = [];
  const walk = (nodes: ComponentNode[], root = false): void => {
    for (const node of nodes) {
      if (!root && ['stage', 'parallelstage', 'podset'].includes(node.type)) continue;
      if (['parachute', 'streamer'].includes(node.type) && flownDeployEvent(node['deployEvent']) === 'ejection') {
        const extra = typeof node['deployDelay'] === 'number' && node['deployDelay'] > 0 ? ` after another ${node['deployDelay']} s` : '';
        devices.push(`${node.name ?? 'Recovery device'}${extra}`);
      }
      walk(node.children ?? []);
    }
  };
  walk(recoveryAssembly(tree, mountId), true);
  return devices.length ? `This motor's zero-second delay is set to fire its ejection charge at burnout. It can trigger ${devices.join(', ')} `
    + 'if the charge and any deployment delay complete before landing or a simulation abort and that device has not already deployed. '
    + 'Recovery can open while the rocket is still moving fast, which can tear the device or damage the airframe. Check the delay and deployment settings; selection remains allowed.' : null;
}

/** N007: kernel Mach is air-relative. Vs is local sound speed from the flown
 * atmosphere. Ground-relative maxVelocity cannot measure this limit in wind. */
export function peakAirspeed(series: Pick<FlightSeries, 'time' | 'mach'> & Record<string, (number | null)[] | undefined>): {
  value: number | null; complete: boolean;
} {
  let value: number | null = null;
  let complete = (series.time?.length ?? 0) > 0;
  for (let i = 0; i < (series.time?.length ?? 0); i++) {
    const mach = series.mach?.[i], sound = series['Vs']?.[i];
    if (typeof mach !== 'number' || !Number.isFinite(mach) || mach < 0
      || typeof sound !== 'number' || !Number.isFinite(sound) || sound <= 0) { complete = false; continue; }
    const speed = mach * sound;
    if (Number.isFinite(speed)) value = Math.max(value ?? 0, speed);
    else complete = false;
  }
  return { value, complete };
}

/** N007/N010: compare recorded evidence; limits never reach simulation options.
 * Reaching an arming height does not establish that hardware actually armed. */
export function flightLimitAdvice(result: FlightResult, rawLimits: FlightAdvisories | undefined,
  configuration: string, tree?: RocketTree, units: UnitSelection = INITIAL_UNITS): { text: string; level: 'info' | 'caution' }[] {
  const limits = normalizeFlightAdvisories(rawLimits);
  if (!limits) return [];
  const notes: { text: string; level: 'info' | 'caution' }[] = [];
  const quantity = (kind: 'velocity' | 'distance', si: number): string => {
    const symbol = units[kind], siSymbol = kind === 'velocity' ? 'm/s' : 'm';
    return symbol === siSymbol ? `${si.toFixed(1)} ${siSymbol}`
      : `${fmtSi(kind, symbol, si, 3)} ${symbol} [${si.toFixed(1)} ${siSymbol}]`;
  };
  const nodes: ComponentNode[] = [];
  const walk = (parts: ComponentNode[]): void => {
    for (const part of parts) { nodes.push(part); walk(part.children ?? []); }
  };
  walk(tree?.components ?? []);
  const peak = (values: (number | null)[] | undefined): number | null => {
    const valid = (values ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return valid.length ? valid.reduce((max, v) => Math.max(max, v)) : null;
  };
  const flights = [{ name: 'Flight', series: result.series, events: result.events,
    apogee: result.summary.maxAltitude, mach: result.summary.maxMachNumber },
  ...boosterBranches(result).map(b => ({ name: b.name, series: b.series, events: b.events,
    apogee: peak(b.series.altitude), mach: peak(b.series.mach) }))];
  for (const flight of flights) {
    const context = `${configuration} — ${flight.name}`;
    if (limits.maxAirspeedMs !== undefined) {
      const peak = peakAirspeed(flight.series);
      if (peak.value !== null && peak.value > limits.maxAirspeedMs) {
        notes.push({ text: `${context}: recorded airspeed ${quantity('velocity', peak.value)} exceeded your maximum of ${quantity('velocity', limits.maxAirspeedMs)}. This is your limit, not a structural rating.`, level: 'caution' });
      } else if (!peak.complete) {
        notes.push({ text: `${context}: the app cannot check your airspeed limit of ${quantity('velocity', limits.maxAirspeedMs)} because airspeed telemetry is incomplete. Ground speed is not a substitute.`, level: 'info' });
      }
    }
    if (limits.maxMach !== undefined) {
      if (typeof flight.mach === 'number' && Number.isFinite(flight.mach) && flight.mach > limits.maxMach) {
        notes.push({ text: `${context}: maximum Mach ${flight.mach.toFixed(3)} exceeded your maximum of Mach ${limits.maxMach}. This is your limit, not a structural rating.`, level: 'caution' });
      } else if (!Number.isFinite(flight.mach)) {
        notes.push({ text: `${context}: the app cannot check your Mach limit because the maximum Mach is unavailable.`, level: 'info' });
      }
    }
    if (limits.armingAltitudeM === undefined) continue;
    const height = limits.armingAltitudeM;
    const band = limits.armingCautionBandM ?? 0;
    const check = (label: string, altitude: number | null): void => {
      if (altitude === null || !Number.isFinite(altitude)) {
        notes.push({ text: `${context}: the app cannot check ${label} against your electronics arming altitude; AGL altitude is unavailable.`, level: 'info' });
      } else if (altitude <= height + band) {
        const below = altitude < height;
        notes.push({ text: `${context}: ${label} at ${quantity('distance', altitude)} AGL is ${below ? 'below your arming altitude' : 'within your arming caution band'} (arming ${quantity('distance', height)} AGL, band ${quantity('distance', band)}). `
          + 'If recovery depends on these electronics, they may not be armed when needed and recovery may fail. This comparison does not prove the electronics armed.', level: 'caution' });
      }
    };
    const aborted = flight.events.some(e => e.type === 'SIM_ABORT');
    check('Apogee', aborted || !flight.events.some(e => e.type === 'APOGEE') ? null : flight.apogee);
    const groundTime = flight.events.find(e => e.type === 'GROUND_HIT')?.time;
    for (const event of flight.events.filter(e => e.type === 'RECOVERY_DEVICE_DEPLOYMENT'
      && (groundTime === undefined || e.time < groundTime))) {
      const matches = nodes.filter(n => ['parachute', 'streamer'].includes(n.type)
        && (event.sourceId ? n.id === event.sourceId : n.name === event.source));
      // Duplicate names and unknown ownership cannot establish electronics.
      if (matches.length !== 1 || ['ejection', 'never'].includes(flownDeployEvent(matches[0]!['deployEvent']))) continue;
      const i = flight.series.time?.findIndex(t => t === event.time) ?? -1;
      let altitude: number | null = i >= 0 ? flight.series.altitude?.[i] ?? null : null;
      if (i < 0) {
        const hi = flight.series.time?.findIndex(t => t !== null && t > event.time) ?? -1;
        if (hi > 0) {
          const t0 = flight.series.time[hi - 1], t1 = flight.series.time[hi];
          const h0 = flight.series.altitude?.[hi - 1], h1 = flight.series.altitude?.[hi];
          if (typeof t0 === 'number' && typeof t1 === 'number' && t1 > t0
            && typeof h0 === 'number' && typeof h1 === 'number' && Number.isFinite(h0) && Number.isFinite(h1)) {
            altitude = h0 + (h1 - h0) * (event.time - t0) / (t1 - t0);
          }
        }
      }
      check(`${matches[0]!.name ?? 'Recovery device'} deployment`, altitude);
    }
  }
  return notes;
}
