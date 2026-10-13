import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrkRocket, type AeroDiagnostics, type RocketTree } from '@online-openrocket/engine';
import { rollPlaneAnalysis } from './rollPlaneAnalysis.js';

const cp = (x: number | null, cna = 2): AeroDiagnostics['cp'] => [x, 0, 0, cna];
const diagnostics = (planes: AeroDiagnostics['cp'][]): AeroDiagnostics => ({
  cp: planes[0]!, worstCP: cp(0.4), cpByTheta: planes, stallMargin: 0.2,
});

describe('N022 roll-plane diagnostics', () => {
  it('keeps undefined and zero-lift planes as gaps and uses the kernel worst plane', () => {
    const d = diagnostics([cp(0, 0), cp(0.8), cp(0.4), cp(null), cp(Infinity), cp(0.3, 1e-10)]);
    const before = structuredClone(d);
    const a = rollPlaneAnalysis(d, { cg: 0.3, refDiameter: 0.1 });
    expect(a.angles).toEqual([0, 1, 2, 3, 4, 5]);
    expect(a.cp).toEqual([null, 0.8, 0.4, null, null, null]);
    expect(a.noLift).toEqual([true, false, false, false, false, true]);
    expect(a.margin[1]).toBeCloseTo(5, 12);
    expect(a.margin[2]).toBeCloseTo(1, 12);
    expect(a.worstAngle).toBe(2);
    expect(d).toEqual(before);
  });
  it('does not move the marker to a nearly equal earlier CP', () => {
    const d = diagnostics([cp(0.4 + 1e-10), cp(0.4)]);
    expect(rollPlaneAnalysis(d, { cg: 0.3, refDiameter: 0.1 }).worstAngle).toBe(1);
  });
  it('retains a nonzero negative-slope plane without selecting it as the kernel worst plane', () => {
    const d = diagnostics([cp(0.2, -2), cp(0.4)]);
    const a = rollPlaneAnalysis(d, { cg: 0.3, refDiameter: 0.1 });
    expect(a.cp).toEqual([0.2, 0.4]);
    expect(a.noLift).toEqual([false, false]);
    expect(a.worstAngle).toBe(1);
    d.worstCP = cp(0.2, -2);
    expect(rollPlaneAnalysis(d, { cg: 0.3, refDiameter: 0.1 }).worstAngle).toBeNull();
  });
  it('leaves a flown result unchanged after diagnostic queries at different Mach and AoA', () => {
    const r = OrkRocket.build({
      noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
      bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003, materialDensity: 950 },
      fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
      motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
      parachute: { diameter: 0.3 },
    });
    r.setMotor({ designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
      times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2], thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132] });
    const options = { launchRodLength: 1, timeStep: 0.05 };
    const before = r.simulate(options);
    const info = r.staticInfo();
    for (const mach of [0.3, 1, 2]) for (const aoa of [0, 10 * Math.PI / 180]) {
      rollPlaneAnalysis(r.aeroDiagnostics(mach, aoa), info);
    }
    const after = r.simulate(options);
    // Same-runtime differential, no hard-coded kernel floating-point values.
    expect(after.summary).toEqual(before.summary);
    expect(after.series).toEqual(before.series);
    expect(after.events).toEqual(before.events);
  });
  it('does not divide by an absent reference diameter or invent a worst plane', () => {
    const d = diagnostics([cp(0.8), cp(0.9)]);
    const a = rollPlaneAnalysis(d, { cg: 0.3, refDiameter: 0 });
    expect(a.margin).toEqual([null, null]);
    expect(a.worstAngle).toBeNull();
    d.worstCP = cp(0, 0);
    expect(rollPlaneAnalysis(d, { cg: NaN, refDiameter: 0.1 }).worstAngle).toBeNull();
  });
  it.each([[3, 'rounded'], [2, 'rounded'], [3, 'airfoil'], [2, 'airfoil']] as const)(
    'agrees with the kernel for %i %s freeform fins without changing static figures', (count, crossSection) => {
    const tree = JSON.parse(readFileSync(new URL('../../../../validation/fixtures/arcas-short.json', import.meta.url), 'utf8')) as RocketTree;
    const fin = tree.components[1]!.children![0]!;
    delete fin['airfoilSection'];
    Object.assign(fin, { type: 'freeformfinset', crossSection, finCount: count,
      points: [[0, 0], [0.035, 0.055], [0.075, 0.055], [0.12, 0]], rotation: 0.4 });
    const r = OrkRocket.buildTree(tree);
    const before = r.staticInfo();
    const d = r.aeroDiagnostics(0.3, 0);
    const a = rollPlaneAnalysis(d, before);
    expect(a.cp).toHaveLength(360);
    expect(a.worstAngle).not.toBeNull();
    // Differential check of the same query, tolerance covers runtime last bits.
    expect(a.cp[a.worstAngle!]!).toBeCloseTo(d.worstCP[0]!, 10);
    expect(a.cp[a.worstAngle!]!).toBeCloseTo(before.cpWorst!, 10);
    expect(r.staticInfo()).toEqual(before);
  });
});
