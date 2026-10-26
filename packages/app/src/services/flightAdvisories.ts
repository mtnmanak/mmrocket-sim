import type { ComponentNode, FlightResult, FlightSeries, RocketTree } from '@online-openrocket/engine';
import { boosterBranches } from '@online-openrocket/engine';
import { normalizeFlightAdvisories, type FlightAdvisories } from '../prefs/flightAdvisories.js';
import { INITIAL_UNITS, noticeEqual, noticeComparison, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import { flownDeployEvent } from '../tree/deployEvent.js';

// N004: NAR Model Rocket Safety Code §9 (Launch Site), NAR High Power Rocket
// Safety Code §9 (Flight Safety): no launch above 20 mph. Tripoli Unified
// Safety Code §9-3: no launch when sustained surface winds exceed 20 MPH.
// https://www.nar.org/ModelRocketSafetyCode
// https://www.nar.org/content.aspx?page_id=22&club_id=114127&module_id=669238 (the bare page_id=22 redirects to the home page)
// https://www.tripoli.org/safetycode (checked 2026-10-13)
export const SURFACE_WIND_LIMIT_MS = 20 * 0.44704;

export function groundWindAdvice(wind: number, units: UnitSelection = INITIAL_UNITS): string | null {
  if (!Number.isFinite(wind) || wind <= SURFACE_WIND_LIMIT_MS || noticeEqual(wind, SURFACE_WIND_LIMIT_MS)) return null;
  const windText = noticeQuantity('windspeed', wind, units, { digits: 3, otherDigits: 3, against: SURFACE_WIND_LIMIT_MS });
  const limitText = noticeQuantity('windspeed', SURFACE_WIND_LIMIT_MS, units,
    { digits: 3, otherDigits: 3,
      defined: { value: 20, symbol: 'mph' } });
  // N004: finite display precision must not turn an exceedance into equality.
  const measurement = !windText.startsWith('just above')
    ? `Surface wind average ${windText} exceeds ${limitText}. `
    : `Surface wind average is just above ${limitText}. `;
  return measurement
    + `NAR model and high-power codes apply that limit to launch wind; Tripoli applies this limit to sustained surface wind. `
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
  const quantity = (kind: 'velocity' | 'altitude', si: number, digits = 3, parenthesized = false): string => {
    return noticeQuantity(kind, si, units, { digits: 3, otherDigits: digits, parenthesized, grouped: true });
  };
  const comparison = (kind: 'velocity' | 'altitude', actual: number, limit: number) => {
    const [actualText, limitText] = noticeComparison(kind, actual, limit, units, {
      digits: 3, otherDigits: 1, grouped: true,
    });
    return { actual: actualText, limit: limitText, digits: 1, indistinguishable: actualText.startsWith('just ') };
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
      if (peak.value !== null && peak.value > limits.maxAirspeedMs && !noticeEqual(peak.value, limits.maxAirspeedMs)) {
        const pair = comparison('velocity', peak.value, limits.maxAirspeedMs);
        const measurement = pair.indistinguishable ? 'is just above' : `${pair.actual} exceeded`;
        notes.push({ text: `${context}: recorded airspeed ${measurement} your maximum of ${pair.limit}. This is your limit, not a structural rating.`, level: 'caution' });
      } else if (!peak.complete) {
        notes.push({ text: `${context}: the app cannot check your airspeed limit of ${quantity('velocity', limits.maxAirspeedMs)} because airspeed telemetry is incomplete. Ground speed is not a substitute.`, level: 'info' });
      }
    }
    if (limits.maxMach !== undefined) {
      if (typeof flight.mach === 'number' && Number.isFinite(flight.mach) && flight.mach > limits.maxMach) {
        const recorded = flight.mach.toFixed(3);
        const measurement = Number(recorded) <= limits.maxMach ? 'is just above' : `${recorded} exceeded`;
        notes.push({ text: `${context}: maximum Mach ${measurement} your maximum of Mach ${limits.maxMach}. This is your limit, not a structural rating.`, level: 'caution' });
      } else if (!Number.isFinite(flight.mach)) {
        notes.push({ text: `${context}: the app cannot check your Mach limit because the maximum Mach is unavailable.`, level: 'info' });
      }
    }
    if (limits.armingAltitudeM === undefined) continue;
    const height = limits.armingAltitudeM;
    const band = limits.armingCautionBandM ?? 0;
    const check = (label: string, altitude: number | null, unavailable = 'AGL altitude is unavailable'): void => {
      if (altitude === null || !Number.isFinite(altitude)) {
        notes.push({ text: `${context}: the app cannot check ${label} against your electronics arming altitude; ${unavailable}.`, level: 'info' });
      } else if (altitude <= height + band || noticeEqual(altitude, height + band)) {
        const below = altitude < height && !noticeEqual(altitude, height);
        const pair = noticeEqual(altitude, height) ? null : comparison('altitude', altitude, height);
        const measurement = !pair ? 'is at your arming altitude, within your arming caution band' : pair.indistinguishable ? `is just ${below ? 'below' : 'above'} your arming altitude`
          : `at ${pair?.actual ?? quantity('altitude', altitude)} AGL is ${below ? 'below your arming altitude' : 'within your arming caution band'}`;
        notes.push({ text: `${context}: ${label} ${measurement} (arming ${quantity('altitude', height, pair?.digits ?? 3, true)} AGL, band ${quantity('altitude', band, 3, true)}). `
          + 'If recovery depends on these electronics, they may not be armed when needed and recovery may fail. This comparison does not prove the electronics armed.', level: 'caution' });
      }
    };
    const aborted = flight.events.some(e => e.type === 'SIM_ABORT');
    // N010: an incomplete flight cannot establish its final maximum, even
    // when finite AGL samples and an apogee event were recorded before abort.
    if (aborted) check('Apogee', null, 'the simulation aborted, so the final flight maximum is not established');
    else if (!flight.events.some(e => e.type === 'APOGEE')) {
      check('Apogee', null, 'no apogee event was recorded, so the flight maximum is not established');
    } else check('Apogee', flight.apogee);
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
