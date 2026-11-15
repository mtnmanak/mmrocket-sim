// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { MOTOR_DB } from './motorDb.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import type { MountMotor } from '../model/design.js';
import { simulateDesign } from './simulateDesign.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
const load = async (designation: string): Promise<MountMotor> => {
  const entry = MOTOR_DB.find(m => m.designation === designation)!;
  expect(entry).toBeDefined();
  return { label: entry.designation, meta: { label: entry.designation, motorId: entry.motorId },
    spec: await bundledOnlyFetchSpec(entry, 0), ignition: { event: 'automatic', delay: 0 } };
};
const mount = (id: string, direction: number, radius = 0.035): ComponentNode => ({ type: 'innertube',
  id, name: id, length: 0.4, outerRadius: 0.03, thickness: 0.001, motorMount: true,
  radialPosition: radius, radialDirection: direction, position: { method: 'bottom', offset: 0 } });
const staged = (boosterOffAxis = false): RocketTree => ({ name: 'Staged thrust regression', components: [
  { type: 'stage', id: 'sustainer', name: 'Sustainer', children: [
    { type: 'nosecone', length: 0.3, aftRadius: 0.075, shape: 'ogive', thickness: 0.002 },
    { type: 'bodytube', length: 1.2, outerRadius: 0.075, thickness: 0.002, children: [
      { type: 'masscomponent', mass: 0.3, length: 0.05, radius: 0.02, position: { method: 'top', offset: 0 } },
      { type: 'trapezoidfinset', finCount: 4, rootChord: 0.3, tipChord: 0.12, height: 0.15,
        sweep: 0.15, thickness: 0.003, crossSection: 'rounded', position: { method: 'bottom', offset: 0 } },
      mount('upper-a', 0, boosterOffAxis ? 0 : 0.035), mount('upper-b', Math.PI),
      { type: 'parachute', diameter: 1, deployEvent: 'apogee' },
    ] },
  ] },
  { type: 'stage', id: 'booster', name: 'Booster', separationEvent: 'ejection', separationDelay: 0, children: [
    { type: 'bodytube', length: 0.5, outerRadius: 0.075, thickness: 0.002, children: [
      { type: 'freeformfinset', finCount: 4, thickness: 0.003, crossSection: 'rounded',
        points: [[0, 0], [0.2, 0.2], [0.4, 0.2], [0.4, 0]], position: { method: 'bottom', offset: 0 } },
      mount('boost', 0, boosterOffAxis ? 0.035 : 0),
      ...(boosterOffAxis ? [mount('empty-boost', Math.PI)] : []),
    ] },
  ] },
] });

it.each(['one upper tube', 'mixed upper pair', 'one booster tube'])(
  'round 3 real simulateDesign: %s retains Danger through staging and stored warnings', async scenario => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
    const tree = staged(scenario === 'one booster tube');
    const [boost, upper, other] = await Promise.all([load('J350W'), load('G80T'), load('G64W')]);
    const motors = { boost: scenario === 'one booster tube' ? other : boost,
      'upper-a': scenario === 'one booster tube' ? boost : upper,
      ...(scenario === 'mixed upper pair' ? { 'upper-b': other } : {}) };
    const out = await simulateDesign({ tree, mountMotors: motors, launch: DEFAULT_CONDITIONS,
      measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null, unmatchedRefs: {} },
    { aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false } });
    const events = [...out.result.events, ...(out.result.branches ?? []).flatMap(b => b.events)];
    expect(events.filter(e => e.type === 'SIM_ABORT'), JSON.stringify(events)).toEqual([]);
    const split = events.find(e => e.type === 'STAGE_SEPARATION' && e.sourceId === 'booster');
    expect(split, JSON.stringify(events)).toBeDefined();
    const ignition = events.find(e => e.type === 'IGNITION' && e.motorMountId === 'upper-a');
    expect(ignition).toBeDefined();
    expect(Math.abs(ignition!.time - split!.time)).toBeLessThan(1e-6);
    const warnings = out.run.simWarnings!.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_'));
    expect(warnings.some(w => w.key === 'ASYMMETRIC_THRUST_DANGER')).toBe(true);
    if (scenario !== 'one booster tube') {
      expect(warnings.some(w => w.message.startsWith('Sustainer:'))).toBe(true);
    } else {
      expect(asymmetricThrustWarnings(tree, Object.entries(motors))[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
      expect(warnings.some(w => w.message.includes('Firing then: boost.'))).toBe(true);
    }
  }, 60_000,
);
