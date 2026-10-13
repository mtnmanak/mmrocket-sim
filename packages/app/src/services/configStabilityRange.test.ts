import { describe, expect, it } from 'vitest';
import { OrkRocket, type StaticInfo } from '@online-openrocket/engine';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { prepareStabilityCases, stabilityRange, StabilityRangeCalculator } from './configStabilityRange.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';

const motor: MountMotor = { label: 'C6', meta: { label: 'C6' }, ignition: { event: 'automatic', delay: 0 },
  spec: { designation: 'C6', diameter: 0.018, length: 0.07, times: [0, 0.2, 1.8],
    thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.012], cgX: 0.035, ejectionDelay: 5 } };
function setup() {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const config: SavedConfig = { id: 'a', name: 'Club field', isDefault: true, motors: { [mount]: motor } };
  return { tree, mount, config, input: { tree, configs: [config], kbf: true, supersonic: false,
    measuredDryMassKg: null } };
}

describe('configuration stability range (N024)', () => {
  it('includes the empty rocket, every mount, and per-configuration stage mass/CG without changing input', () => {
    const { tree, mount, config, input } = setup();
    const before = structuredClone(input);
    const stage = tree.components[0]!.id!;
    const cases = prepareStabilityCases({ ...input, configs: [config, { ...config, id: 'b', name: 'Heavier',
      stageMassOverrides: { [stage]: { overrideMass: 0.2, overrideCGX: 0.1,
        overrideSubcomponentsMass: true, overrideSubcomponentsCG: true } } }] });
    expect(cases.map(c => c.label)).toEqual(['Empty rocket (no motor)', 'Club field', 'Heavier']);
    expect(cases[0]!.input.assigned).toEqual([]);
    expect(cases[1]!.input.assigned.map(([id]) => id)).toEqual([mount]);
    expect(cases[2]!.input.tree.components[0]!.overrideCGX).toBe(0.1);
    expect(cases[2]!.input.tree.components[0]!.overrideMass).toBe(0.2);
    expect(input).toEqual(before);
  });
  it('does not report inactive stages or unmatched motors as calculated configurations', () => {
    const { tree, config, input } = setup();
    const cases = prepareStabilityCases({ ...input, configs: [
      { ...config, stageActiveness: { [tree.components[0]!.id!]: false } },
      { ...config, id: 'missing', unmatched: ['EX load'] },
    ] });
    expect(cases[1]!.unavailable).toMatch(/inactive stages/i);
    expect(cases[2]!.unavailable).toMatch(/unresolved motor/i);
  });
  it('uses the worst-plane margin, excludes absent force, and names the minimum', () => {
    const base = { cp: 0.5, cpWorst: 0.3, cg: 0.2, refDiameter: 0.05, length: 1,
      stabilityCalibers: 6, stabilityCalibersWorst: 2, cna: 4, cnaWorst: 3 } as StaticInfo;
    const range = stabilityRange([
      { id: 'empty', label: 'Empty', info: { ...base, stabilityCalibersWorst: 3 } },
      { id: 'loaded', label: 'Heavy motor', info: base },
      { id: 'no-lift', label: 'Bare tube', info: { ...base, cna: 0, cnaWorst: 0 } },
    ]);
    expect(range.min?.cal).toBe(2);
    expect(range.max?.cal).toBe(3);
    expect(range.min?.label).toBe('Heavy motor');
    expect(range.cases[2]!.unavailable).toMatch(/normal force/i);
    expect(range.complete).toBe(false);
  });
  it('caches static results, invalidates motor mass and aero changes, and cancels between cases', async () => {
    const { input, mount, config } = setup();
    const calc = new StabilityRangeCalculator(KERNEL_HANDLES);
    const first = await calc.calculate(input);
    expect(first?.complete).toBe(true);
    const warm = await calc.calculate(input);
    expect(warm?.builds).toBe(0);
    const heavy = await calc.calculate({ ...input, configs: [{ ...config, motors: { [mount]:
      { ...motor, spec: { ...motor.spec, masses: [0.1, 0.09, 0.08] } } } }] });
    expect(heavy?.builds).toBe(1);
    expect(heavy?.cases[1]!.cal).toBeLessThan(first!.cases[1]!.cal!);
    const model = await calc.calculate({ ...input, kbf: false });
    expect(model?.builds).toBe(2);
    let checks = 0;
    expect(await calc.calculate(input, () => ++checks > 1)).toBeNull();
  });
  it.each(['rounded', 'airfoil'])('agrees with the existing static build including %s freeform fins and measured pad hardware', async crossSection => {
    const { tree, mount, config, input } = setup();
    const body = tree.components[0]!.children!.find(n => n.type === 'bodytube')!;
    const fins = body.children!.find(n => n.type === 'trapezoidfinset')!;
    Object.assign(fins, { type: 'freeformfinset', crossSection,
      points: [[0, 0], [0.02, 0.05], [0.07, 0.05], [0.1, 0]] });
    config.motors[mount] = { ...motor, padMassKg: 0.12, padMassWeighedWith: 'legacy' };
    const cases = prepareStabilityCases(input);
    const expected = buildDesign(cases[1]!.input, KERNEL_HANDLES);
    expect('error' in expected).toBe(false);
    const result = await new StabilityRangeCalculator(KERNEL_HANDLES).calculate(input);
    // Same calculation, tolerance permits Node 22/24 last-bit differences.
    if ('error' in expected) throw new Error(expected.error);
    expect(result!.cases[1]!.cal).toBeCloseTo(expected.info.stabilityCalibersWorst ?? expected.info.stabilityCalibers, 10);
    expect(result!.cases[1]!.info?.mass).toBeCloseTo(expected.info.mass, 10);
  });
  it('counts every loaded mount and clears overrides in an explicitly empty mass snapshot', async () => {
    const { tree, config, input, mount } = setup();
    const body = tree.components[0]!.children!.find(n => n.type === 'bodytube')!;
    body.children!.push({ ...motorMounts(tree)[0]!, id: 'second' });
    const stage = tree.components[0]!;
    Object.assign(stage, { overrideMass: 0.2, overrideCGX: 0.1,
      overrideSubcomponentsMass: true, overrideSubcomponentsCG: true });
    const cleared = { ...config, id: 'clear', name: 'Cleared', stageMassOverrides: { [stage.id!]: {} },
      motors: { [mount]: motor, second: motor } };
    const cases = prepareStabilityCases({ ...input, configs: [config, cleared] });
    expect(cases[2]!.input.assigned.map(([id]) => id)).toEqual([mount, 'second']);
    expect(cases[2]!.input.tree.components[0]!.overrideMass).toBeUndefined();
    const result = await new StabilityRangeCalculator(KERNEL_HANDLES).calculate({ ...input, configs: [cleared] });
    expect(result!.cases[1]!.info!.mass - result!.cases[1]!.info!.massEmpty).toBeCloseTo(0.048, 10);
  });
  it('labels an unresolved working set and a refused kernel motor instead of including partial mass', async () => {
    const { input, config, mount } = setup();
    const cases = prepareStabilityCases({ ...input, workingUnmatchedRefs: { [mount]: {
      designation: 'EX', manufacturer: 'Unknown', diameter: 0.018, length: 0.07, delay: 5 } } });
    expect(cases.at(-1)?.label).toBe('Working settings');
    expect(cases.at(-1)?.unavailable).toMatch(/unresolved motor/i);
    const bad = { ...motor, spec: { ...motor.spec, masses: [NaN, 0.02, 0.01] } };
    const result = await new StabilityRangeCalculator(KERNEL_HANDLES).calculate({ ...input,
      configs: [{ ...config, motors: { [mount]: bad } }] });
    expect(result!.complete).toBe(false);
    expect(result!.cases[1]!.cal).toBeUndefined();
    expect(result!.cases[1]!.unavailable).toMatch(/refused a motor/i);
  });
  it('can run with an independent engine factory without resetting the active rocket', async () => {
    const { input } = setup();
    const active = OrkRocket.buildTree(input.tree);
    const before = active.staticInfo();
    // Worker isolation supplies a separate module instance in production; here no-reset verifies the contract.
    await new StabilityRangeCalculator({ ...KERNEL_HANDLES, reset: () => {} }).calculate(input);
    expect(active.staticInfo()).toEqual(before);
  });
});
