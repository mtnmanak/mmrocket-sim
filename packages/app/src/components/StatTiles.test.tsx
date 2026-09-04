// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlightStats, RESULT_TILE_METRICS } from './StatTiles.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { DeploymentReport, SimRun } from '../services/simReport.js';

/**
 * The results tiles against a flight the kernel could not compute.
 *
 * Every "Results (SI)" field on SimRun is typed `number`, but the Java→JS
 * bridge writes `null` for any NaN or Infinity, and FlightData initialises
 * maxAcceleration, maxMachNumber and groundHitVelocity to NaN. A mount with no
 * motor aborts exactly that way, and 17 of the 72 flyable beta .ork imports
 * abort — so the null path is a routine flight here, not a corner.
 *
 * Two failures this file exists to stop coming back:
 *  - `r.maxMach.toFixed(2)` threw during FlightStats's render. Nothing above it
 *    is an error boundary, so React unmounted the whole app and the user lost
 *    the unsaved design; re-selecting the same run re-triggered it.
 *  - fmtSi divides by the unit factor and JS coerces null to 0, so the Landing
 *    rate tile — the most safety-relevant number on the page — read
 *    "0.000 ft/s" for a rocket that never left the pad.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const U = { dist: 'ft', vel: 'ft/s', acc: 'G', mass: 'oz', stability: 'cal' as const };

const deployment = (over: Partial<DeploymentReport>): DeploymentReport => ({
  device: 'Drogue', time: 6.8, altitude: 331, velocityAtDeployment: 4.2,
  descentRate: 21.3, groundSpeed: 24.0, isLanding: false,
  openingOk: true, descentOk: true,
  cd: 0.8, cdNominal: 0.8, diameter: 0.6, spillHoleDiameter: null,
  ...over,
});

/** A complete, self-consistent flight — every tile has a real number. */
const GOOD = {
  id: 'r1', when: 1_756_000_000_000, rocket: 'Big Dog 4in', motor: 'C6',
  manufacturer: 'Estes', motorDiameterMm: 18, delayS: 5,
  maxAltitude: 331.7, maxVelocity: 116.2, maxMach: 0.35, maxAcceleration: 227.5,
  timeToApogee: 6.8, timeToBurnout: 2, timeToRodDeparture: 0.15,
  rodExitVelocity: 18.4, thrustToWeightAtRod: 12.3,
  launchMass: 0.051, burnoutMass: 0.04,
  rodExitAoa: 0, launchCG: 0.26, launchCP: 0.29,
  launchStaticMarginCal: 1.3, launchStaticMarginPct: 3.5,
  altitudeAtDeployment: 331, velocityAtDeployment: 4.2,
  deployments: [
    deployment({}),
    deployment({ device: 'Main', time: 90, isLanding: true, descentRate: 3.4, groundSpeed: 5.1 }),
  ],
  landingRate: 3.4, safeLandingRate: true,
  groundHitVelocity: 5.1, totalFlightTime: 104,
  optimumDelayS: 4.9, recommendedDelayS: 5,
  safeLiftoffSpeed: true, safeThrustToWeight: true, safeDeployment: true,
  staticMarginOk: true, weathercockRisk: 'low',
} as unknown as SimRun;

/**
 * The result fields the bridge can null out. Listed by name rather than
 * "every numeric key" so that a new SimRun field has to be considered here —
 * that is the whole point of the sweep below.
 */
const RESULT_FIELDS = [
  'maxAltitude', 'maxVelocity', 'maxMach', 'maxAcceleration', 'timeToApogee',
  'rodExitVelocity', 'thrustToWeightAtRod', 'launchMass', 'burnoutMass',
  'landingRate', 'groundHitVelocity', 'totalFlightTime', 'optimumDelayS',
  'launchStaticMarginCal', 'launchStaticMarginPct',
] as const;

/** GOOD with every computable result replaced by `fill` (null, or NaN). */
function absent(fill: null | number): SimRun {
  const r = { ...(GOOD as unknown as Record<string, unknown>) };
  for (const k of RESULT_FIELDS) r[k] = fill;
  r.deployments = (GOOD.deployments ?? []).map((d) => ({
    ...d, altitude: fill, velocityAtDeployment: fill, descentRate: fill, groundSpeed: fill,
  }));
  return r as unknown as SimRun;
}

describe('RESULT_TILE_METRICS — a flight the kernel could not compute', () => {
  // The kernel's two shapes of "no number": the bridge's null, and the raw NaN
  // that older stored runs carry. `=== null` catches only the first, which is
  // why every tile tests Number.isFinite instead.
  for (const [name, fill] of [['null', null], ['NaN', NaN]] as const) {
    for (const m of RESULT_TILE_METRICS) {
      it(`${m.id} renders an em-dash, not a number, when every field is ${name}`, () => {
        const v = m.render(absent(fill), U);
        expect(v.value).toBe('—');
      });
    }
  }

  it('never throws — the crash unmounted the whole app', () => {
    for (const fill of [null, NaN] as const) {
      for (const m of RESULT_TILE_METRICS) {
        expect(() => m.render(absent(fill), U)).not.toThrow();
      }
    }
  });

  it('Landing rate says nothing rather than 0 — a zero-rate landing is the safest possible reading', () => {
    const tile = RESULT_TILE_METRICS.find((m) => m.id === 'landingRate')!;
    // The exact SIM_ABORT summary from a mount with no motor: maxAltitude 0,
    // every rate null. fmtSi used to coerce that null to 0 and print
    // "0.000 ft/s" for a rocket still standing on the pad.
    const aborted = { ...GOOD, landingRate: null, groundHitVelocity: null } as unknown as SimRun;
    expect(tile.render(aborted, U).value).toBe('—');
  });

  it('Landing rate falls back to the ground-hit velocity when only the descent rate is missing', () => {
    const tile = RESULT_TILE_METRICS.find((m) => m.id === 'landingRate')!;
    // 5.1 m/s = 16.7 ft/s. A pre-v0.100 stored run has no landingRate at all.
    const old = { ...GOOD, landingRate: null } as unknown as SimRun;
    expect(tile.render(old, U).value).toBe('16.7');
    // ... and a NaN there must fall through too. `??` falls through only on
    // null/undefined, so it would have kept the NaN and printed "NaN ft/s";
    // the tile tests finiteness instead.
    const nan = { ...GOOD, landingRate: NaN } as unknown as SimRun;
    expect(nan.landingRate ?? nan.groundHitVelocity).toBeNaN();
    expect(tile.render(nan, U).value).toBe('16.7');
  });

  it('Max Mach reads the number when there is one', () => {
    const tile = RESULT_TILE_METRICS.find((m) => m.id === 'maxMach')!;
    expect(tile.render(GOOD, U).value).toBe('0.35');
  });

  it('a good flight still prints every tile — the guard must not blank real numbers', () => {
    for (const m of RESULT_TILE_METRICS) {
      expect(m.render(GOOD, U).value, m.id).not.toBe('—');
    }
    const byId = (id: string) => RESULT_TILE_METRICS.find((m) => m.id === id)!.render(GOOD, U).value;
    expect(byId('apogee')).toBe('1088');            // 331.7 m in ft
    expect(byId('flightTime')).toBe('104');
    expect(byId('thrustToWeight')).toBe('12.3 : 1');
    expect(byId('drogueRate')).toBe('69.9');        // 21.3 m/s in ft/s
    expect(byId('groundSpeed')).toBe('16.7');       // the landing device's 5.1 m/s
  });
});

describe('FlightStats — the aborted flight must not unmount the app', () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (node: React.ReactNode) => act(() => root.render(
    <PrefsProvider>{node}</PrefsProvider>,
  ));

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('renders every tile in the catalog against a null-valued run', () => {
    // Every metric ticked in the ⚙ Choose metrics panel — the persisted state
    // that turned a bad flight into a lost design, since the choice survives
    // the reload the crash forces.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      resultTiles: RESULT_TILE_METRICS.map((m) => m.id),
    }));
    render(<FlightStats run={absent(null)} />);
    const tiles = Array.from(host.querySelectorAll('.stat-tile'));
    expect(tiles.length).toBe(RESULT_TILE_METRICS.length);
    for (const t of tiles) {
      expect(t.querySelector('.stat-value')?.textContent, t.textContent ?? '')
        .toContain('—');
    }
  });

  it('renders the default tiles against a NaN-valued run', () => {
    render(<FlightStats run={absent(NaN)} />);
    expect(host.querySelectorAll('.stat-tile').length).toBe(6);
    expect(host.textContent).not.toContain('NaN');
  });
});
