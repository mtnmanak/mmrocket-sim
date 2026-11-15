// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import presetsJson from '../data/presets.json';
import { num } from '../tree/nodeNum.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { padAir, R_AIR } from './atmosphere.js';
import { presetPatch, type Preset } from './presets.js';
import { descentRate, recoverySizing } from './recoverySizing.js';
import { simulateDesign } from './simulateDesign.js';
import { importRkt } from './rocksimFile.js';

// 662, Tables 1–3: 396 g descent mass, 24 in circle, measured station air.
const MASS = 0.396;
const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 2160, pressureHPa: 784.1,
  temperatureC: -6.4, windAverage: 0, windStdDev: 0, launchRodAngleDeg: 0 };
const spec: MotorSpec = { designation: 'Descent test', diameter: 0.024, length: 0.1,
  cgX: 0.05, times: [0, 0.02, 1.3, 1.32], thrusts: [0, 25, 25, 0],
  masses: [0.08, 0.08, 0.04, 0.04], ejectionDelay: Infinity };

function rocket(chutes: ComponentNode[]): RocketTree {
  return { name: 'Peak of Flight descent', components: [{ type: 'stage', id: 'stage',
    overrideMass: MASS - spec.masses.at(-1)!, overrideSubcomponentsMass: true,
    overrideCGX: 0.2, overrideSubcomponentsCG: true, children: [
      { type: 'nosecone', length: 0.15, aftRadius: 0.029, thickness: 0.001, shape: 'ogive' },
      { type: 'bodytube', id: 'body', length: 0.63, outerRadius: 0.029, thickness: 0.001, children: [
        { type: 'innertube', id: 'mount', length: 0.1, outerRadius: 0.013, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 } },
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.12, tipChord: 0.05, height: 0.06,
          sweep: 0.04, thickness: 0.002, crossSection: 'rounded', position: { method: 'bottom', offset: 0 } },
        ...chutes,
      ] },
    ] }] as ComponentNode[] };
}

async function fly(chutes: ComponentNode[]) {
  const out = await simulateDesign({ tree: rocket(chutes), mountMotors: { mount: {
    label: spec.designation, spec, meta: { label: spec.designation }, ignition: { event: 'launch', delay: 0 },
  } }, launch, measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null, unmatchedRefs: {} });
  expect(out.result.events.some(e => e.type === 'GROUND_HIT')).toBe(true);
  expect(out.result.events.some(e => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')).toBe(true);
  expect(out.result.series.mass.at(-1)).toBeCloseTo(MASS, 10);
  expect(out.run.landingRate).not.toBeNull();
  return Math.abs(out.run.landingRate!);
}

const chute = (diameter: number, id: string): ComponentNode => ({ type: 'parachute', id, diameter, deployEvent: 'apogee' });

describe('Peak of Flight recovery descent anchors (121)', () => {
  it('662: flies the Apogee 29093 canopy in the article’s measured air, on automatic and Cd 0.72', async () => {
    const row = (presetsJson as { presets: Preset[] }).presets.find(p => p.kind === 'Parachute' && p.partNo === '29093')!;
    const canopy: ComponentNode = { ...chute(0.6096, 'chute'), ...presetPatch('parachute', row) };
    const air = padAir(launch);
    const rho = air.pressurePa / (R_AIR * air.temperatureK);
    expect(rho).toBeGreaterThanOrEqual(1.01);
    expect(rho).toBeLessThanOrEqual(1.03);
    expect(num(canopy, 'diameter', 0)).toBeCloseTo(0.6096, 10);
    expect(canopy['cd']).toBeUndefined();
    const automatic = await fly([canopy]);
    expect(automatic).toBeGreaterThanOrEqual(5);
    expect(automatic).toBeLessThanOrEqual(7);
    const explicit = await fly([{ ...canopy, cd: 0.72 }]);
    expect(explicit).toBeGreaterThanOrEqual(5.5);
    expect(explicit).toBeLessThanOrEqual(6.5);
    const advice = recoverySizing({ recovery: { state: 'ok', mass: MASS, multiStage: false },
      tree: rocket([canopy]), presets: [row], deviceMass: () => row.mass ?? null, launch });
    expect(advice.state).toBe('ok');
    if (advice.state !== 'ok') throw new Error('No recovery sizing result');
    const sizingRate = descentRate(MASS, advice.main.cd * Math.PI * num(canopy, 'diameter', 0) ** 2 / 4, advice.rho);
    expect(sizingRate).toBeGreaterThanOrEqual(5);
    expect(sizingRate).toBeLessThanOrEqual(7);
  }, 60_000);

  it.each(['tree', 'rkt'] as const)('372: two 12.72 in canopies versus one 18 in, with equal descent mass (%s)', async path => {
    const recovery = (diameterIn: number, count: number) => {
      if (path === 'tree') return Array.from({ length: count }, (_, i) => chute(diameterIn * 0.0254, `chute${i}`));
      const imported = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>372</Name><StageCount>1</StageCount>
        <Stage3Parts><BodyTube><Len>630</Len><OD>58</OD><ID>56</ID><AttachedParts><Parachute><Name>372 canopy</Name>
        <Dia>${diameterIn * 25.4}</Dia><ChuteCount>${count}</ChuteCount></Parachute></AttachedParts></BodyTube></Stage3Parts>
        </RocketDesign></DesignInformation></RockSimDocument>`);
      const walk = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => n.type === 'parachute'
        ? [{ ...n, deployEvent: 'apogee' }] : walk(n.children ?? []));
      return walk(imported.tree.components);
    };
    const one = await fly(recovery(18, 1));
    const two = await fly(recovery(12.72, 2));
    expect(two / one).toBeGreaterThanOrEqual(15 / 15.25);
    expect(two / one).toBeLessThanOrEqual(16 / 13.66);
  }, 60_000);
});
