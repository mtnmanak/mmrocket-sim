import { describe, expect, it, vi } from 'vitest';
import { OrkRocket, type ComponentNode, type RocketTree, type SimulationOptions } from '@online-openrocket/engine';
import { engineTree, defaultTree, findNode, motorMounts, updateNode } from '../tree/treeModel.js';
import { resolveFlightState } from './flightState.js';
import { preflightAudit, readAuditMasses, type AuditMasses } from './preflightAudit.js';

const part = (patch: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'bodytube', id: 'body', name: 'Body', length: 0.4, outerRadius: 0.025,
  thickness: 0.001, density: 680, ...patch,
});
const chute = (patch: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'parachute', id: 'chute', name: 'Main', deployEvent: 'apogee', ...patch,
});
const design = (body = part(), stage: Partial<ComponentNode> = {}): RocketTree => ({
  name: 'Audit rocket', components: [{ type: 'stage', id: 'stage', name: 'Airframe',
    children: [body, { type: 'bodytube', id: 'bay', children: [chute()] }], ...stage }],
});
const masses: AuditMasses = { body: 0.1 };
const kinds = (tree: RocketTree, baseline: AuditMasses = masses) =>
  preflightAudit(tree, baseline).findings.map(f => f.kind);

describe('preflight design advice (N028)', () => {
  it.each([0, 0.009, 1.01])('flags an extreme own mass override of %s kg with its part and both figures', mass => {
    const findings = preflightAudit(design(part({ overrideMass: mass })), masses).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'mass-ratio', tier: 'caution', part: { id: 'body', name: 'Body' },
      mass: { overrideKg: mass, computedKg: 0.1 } });
    expect(findings[0]!.reason).toMatch(/mass|weigh/i);
  });

  it.each([0.01, 0.08, 0.12, 1])('allows ordinary measured/catalogue mass %s kg, including threshold equality', mass => {
    expect(kinds(design(part({ overrideMass: mass, presetManufacturer: 'Example', presetPartNo: 'BT' })))).toEqual([]);
  });

  it('does not compare an assembly replacement to just its shell or zero-mass containers', () => {
    expect(kinds(design(part({ overrideMass: 2, overrideSubcomponentsMass: true, children: [chute()] })))).toEqual([]);
    expect(kinds(design(part(), { overrideMass: 2, overrideSubcomponentsMass: false }))).toEqual([]);
    expect(kinds(design(part({ overrideMass: 0.0001 })), { body: 0.0009 })).toEqual([]);
  });

  it('keeps unknown, zero and failed mass reads unknown rather than declaring the comparison clear', () => {
    const tree = design(part({ overrideMass: 2 }));
    for (const baseline of [{}, { body: null }, { body: 0 }, { body: NaN }]) {
      const result = preflightAudit(tree, baseline);
      expect(result.findings).toEqual([]);
      expect(result.uncheckedMassParts).toEqual([{ id: 'body', name: 'Body' }]);
    }
    expect(kinds(design(part({ overrideMass: NaN })))).toEqual([]);
  });

  it('flags a whole-airframe replacement without a matching CG replacement', () => {
    for (const cg of [{}, { overrideCGX: NaN, overrideSubcomponentsCG: true }]) {
      const findings = preflightAudit(design(part(), {
        overrideMass: 0.5, overrideSubcomponentsMass: true, ...cg,
      }), masses).findings;
      expect(findings).toContainEqual(expect.objectContaining({ kind: 'whole-mass-without-cg',
        tier: 'caution', part: { id: 'stage', name: 'Airframe' } }));
      expect(findings.find(f => f.kind === 'whole-mass-without-cg')!.reason).toMatch(/stability margin/);
    }
    expect(kinds(design(part(), { overrideMass: 0.5, overrideSubcomponentsMass: true,
      overrideCGX: 0.2, overrideSubcomponentsCG: true }))).toEqual([]);
    // A whole-airframe replacement has zero child weight; the stated CG also
    // positions the entire replacement when its separate subcomponents flag is off.
    expect(kinds(design(part(), { overrideMass: 0.5, overrideSubcomponentsMass: true,
      overrideCGX: 0.2 }))).toEqual([]);
    const multi = design(part(), { overrideMass: 0.5, overrideSubcomponentsMass: true });
    multi.components.push({ type: 'stage', id: 'booster' });
    expect(kinds(multi)).not.toContain('whole-mass-without-cg');
  });

  it('links replacement/child overrides to the existing suppression note on the right descendant', () => {
    const tree = design(part({ overrideMass: 0.2, overrideSubcomponentsMass: true,
      children: [{ type: 'masscomponent', id: 'payload', name: 'Payload', overrideMass: 0.1 }] }));
    expect(preflightAudit(tree, masses).findings).toEqual([expect.objectContaining({
      kind: 'covered-mass', tier: 'information', part: { id: 'payload', name: 'Payload' }, target: 'mass-note',
    })]);
    expect(kinds(updateNode(tree, 'body', { overrideSubcomponentsMass: false }))).not.toContain('covered-mass');
    expect(kinds(updateNode(tree, 'body', { overrideMass: undefined }))).not.toContain('covered-mass');
  });

  it('explains unticked nested overrides without treating their weights as an error', () => {
    const tree = design(part({ overrideMass: 0.1, children: [
      { type: 'masscomponent', id: 'payload', name: 'Payload', overrideMass: 0.03 },
    ] }));
    expect(preflightAudit(tree, masses).findings).toContainEqual(expect.objectContaining({
      kind: 'nested-mass', tier: 'information', part: { id: 'body', name: 'Body' },
    }));
    expect(kinds(updateNode(tree, 'payload', { overrideMass: undefined }))).toEqual([]);
  });

  it.each(['fairing', 'protuberance'] as const)('ignores a legacy %s override when counting nested mass overrides', type => {
    const appendage = { type, id: 'legacy', name: 'Appendage', mass: 0.03, overrideMass: 1 } as unknown as ComponentNode;
    const tree = design(part({ overrideMass: 0.1, children: [appendage] }));
    expect(preflightAudit(tree, masses).findings).toEqual([]);
    const build = vi.fn(() => { throw new Error('No mass comparison is applicable'); });
    expect(readAuditMasses(design(part({ children: [appendage] })), build)).toEqual({});
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    [part({ materialName: 'Balsa', density: 10000 }), 'density', 'kg/m³'],
    [part({ children: [chute({ surfaceMaterialName: 'Ripstop nylon', surfaceDensity: 10 })] }), 'surfaceDensity', 'kg/m²'],
    [part({ children: [chute({ lineMaterialName: 'Thread (heavy-duty)', lineDensity: 10 })] }), 'lineDensity', 'kg/m'],
    [part({ children: [{ type: 'freeformfinset', id: 'fin', name: 'Fins', filletRadius: 0.01,
      filletMaterialName: 'Epoxy, unfilled (cured)', filletDensity: 50000 }] }), 'filletDensity', 'kg/m³'],
  ])('checks the named material family with the correct part kind and density units', (body, field, unit) => {
    const findings = preflightAudit(design(body), masses).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'material-density', density: { field, unit } });
    expect(findings[0]!.reason).toContain(unit);
    const bad = findNode(design(body), findings[0]!.part.id)!;
    const good = updateNode(design(body), bad.id!, { [field]: field === 'density' ? 170
      : field === 'surfaceDensity' ? 0.067 : field === 'lineDensity' ? 0.0003 : 1150 });
    expect(kinds(good)).toEqual([]);
  });

  it('does not guess a family for custom/unnamed densities or mix bulk, surface and line units', () => {
    const tree = design(part({ density: 10000, materialName: 'My lightweight layup',
      surfaceMaterialName: 'Ripstop nylon', surfaceDensity: 10 }));
    expect(kinds(tree)).toEqual([]);
    expect(preflightAudit(tree, masses).unknownMaterialCount).toBe(1);
    expect(kinds(design(part({ materialName: 'Balsa', density: 170 })))).toEqual([]);
  });

  it.each([undefined, 'Custom recovery fabric'])('counts applicable zero recovery densities with unknown name %s as unchecked', name => {
    const tree = design(part({ materialName: 'Cardboard', children: [
      chute({ surfaceMaterialName: name, surfaceDensity: 0, lineMaterialName: name, lineDensity: 0 }),
      { type: 'streamer', id: 'streamer', surfaceMaterialName: name, surfaceDensity: 0, deployEvent: 'apogee' },
      { type: 'shockcord', id: 'cord', lineMaterialName: name, lineDensity: 0 },
    ] }));
    expect(preflightAudit(tree, {})).toEqual({ findings: [], uncheckedMassParts: [], unknownMaterialCount: 4 });
  });

  it('leaves absent recovery densities and nonpositive bulk/fillet densities at kernel defaults', () => {
    const tree = design(part({ materialName: 'Balsa', density: 0, children: [
      chute({ surfaceMaterialName: 'Ripstop nylon', lineMaterialName: 'Thread (heavy-duty)' }),
      { type: 'freeformfinset', id: 'fin', materialName: 'Balsa', density: -1, filletRadius: 0.01,
        filletMaterialName: 'Epoxy, unfilled (cured)', filletDensity: 0 },
    ] }));
    expect(preflightAudit(tree, {})).toEqual({ findings: [], uncheckedMassParts: [], unknownMaterialCount: 0 });
  });

  it.each(['fairing', 'protuberance', 'masscomponent', 'stage', 'parachute', 'streamer', 'shockcord'] as const)(
    'does not screen inert bulk material fields on %s', type => {
      const node = { ...part({ materialName: 'Balsa', density: 10000 }), type } as unknown as ComponentNode;
      const result = preflightAudit(design(node), {});
      expect(result.findings).toEqual([]);
      expect(result.unknownMaterialCount).toBe(0);
    });

  it('flags both sides of the density screening range, leaving its endpoints unflagged', () => {
    for (const density of [16, 7551]) {
      expect(kinds(design(part({ materialName: 'Balsa', density })))).toEqual(['material-density']);
    }
    for (const density of [17, 170, 7550]) {
      expect(kinds(design(part({ materialName: 'Balsa', density })))).toEqual([]);
    }
  });

  it('flags no parachute/streamer, but does not call a fitted device safe', () => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', name: 'Airframe', children: [part()] }] };
    expect(preflightAudit(tree, {}).findings).toEqual([expect.objectContaining({
      kind: 'no-recovery', tier: 'danger', part: { id: 'stage', name: 'Airframe' },
    })]);
    expect(kinds(design())).toEqual([]);
    expect(kinds(design(part({ children: [{ ...chute(), type: 'streamer' }] })))).toEqual([]);
  });

  it('reads Never from the effective configuration, defaults/folds exactly as the kernel does', () => {
    const tree = design();
    const projected = resolveFlightState(tree, [], null, { deployments: {
      chute: { deployEvent: 'NEVER', deployAltitude: 200, deployDelay: 0 },
    } }, {}).tree;
    expect(preflightAudit(projected, masses).findings).toEqual([expect.objectContaining({
      kind: 'no-deployment', tier: 'danger', part: { id: 'chute', name: 'Main' }, target: 'deployment',
    })]);
    for (const event of [undefined, 'apogee', 'ALTITUDE', 'launch', 'ejection', 'lowerstageseparation']) {
      expect(kinds(updateNode(projected, 'chute', { deployEvent: event }))).toEqual([]);
    }
    expect(findNode(tree, 'chute')!['deployEvent']).toBe('apogee');
  });

  it('references an existing no-recovery design warning instead of repeating it', () => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 's' }] };
    const result = preflightAudit(tree, {}, ['[Warning.NO_RECOVERY_DEVICE]: already reported']);
    expect(result.findings).toEqual([expect.objectContaining({ kind: 'existing-recovery-note',
      tier: 'information', target: 'design-notes' })]);
    expect(result.findings[0]!.reason).not.toContain('comes down');
  });
});

describe('computed mass evidence is read-only', () => {
  it('accepts an explicit CG without its subtree flag when the whole-airframe mass replaces the contents (real kernel)', () => {
    const tree = defaultTree();
    const stage = tree.components[0]!;
    stage['overrideMass'] = 0.5;
    stage['overrideSubcomponentsMass'] = true;
    stage['overrideCGX'] = 0.2;
    stage['overrideSubcomponentsCG'] = false;
    const rocket = OrkRocket.buildTree(engineTree(tree));
    // The explicitly stated position, within 1 nm; not a stored physics result.
    expect(rocket.staticInfo().cgEmpty).toBeCloseTo(0.2, 9);
    expect(kinds(tree)).not.toContain('whole-mass-without-cg');
  });

  it('builds only for comparable overrides, clears them on a copy and never resets the engine', () => {
    const tree = design(part({ overrideMass: 2 }));
    const before = structuredClone(tree);
    const build = vi.fn((copy: RocketTree) => {
      expect(findNode(copy, 'body')!['overrideMass']).toBeUndefined();
      return { componentInfo: () => ({ mass: 0.1 }) };
    });
    expect(readAuditMasses(tree, build)).toEqual({ body: 0.1 });
    expect(build).toHaveBeenCalledTimes(1);
    expect(tree).toEqual(before);
    readAuditMasses(design(), build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(readAuditMasses(tree, () => { throw new Error('cannot build'); })).toEqual({ body: null });
    expect(readAuditMasses(tree, () => ({ componentInfo: () => { throw new Error('cannot read'); } }))).toEqual({ body: null });
  });

  it.each(['rounded', 'airfoil'])('reads all freeform fins together with %s profile, leaving the flown handle intact', profile => {
    const tree = defaultTree();
    const body = tree.components[0]!.children!.find(n => n.type === 'bodytube')!;
    const fins: ComponentNode = { type: 'freeformfinset', id: 'free', name: 'Freeform fins', finCount: 3,
      crossSection: profile, thickness: 0.003, density: 630, overrideMass: 0.5,
      points: [[0, 0], [0.02, 0.055], [0.07, 0.045], [0.12, 0]] };
    body.children!.push(fins);
    const flown = OrkRocket.buildTree(engineTree(tree));
    const before = flown.staticInfo();
    const baseline = readAuditMasses(tree);
    const unoverridden = OrkRocket.buildTree(engineTree(updateNode(tree, 'free', { overrideMass: undefined })));
    const fullSetMass = unoverridden.componentInfo('free').mass;
    // Independent public-handle read, within 0.5 micrograms across kernel runtimes.
    expect(baseline.free).toBeCloseTo(fullSetMass, 9);
    expect(baseline.free).toBeGreaterThan(0);
    expect(baseline.free).toBeLessThan(0.5);
    expect(preflightAudit(tree, baseline).findings).toContainEqual(expect.objectContaining({ kind: 'mass-ratio', part: { id: 'free', name: 'Freeform fins' } }));
    // Differential reads from the same untouched handle, not hard-coded kernel floats.
    expect(flown.staticInfo()).toEqual(before);
    expect(flown.componentInfo('free').mass).toBeCloseTo(0.5, 9); // Sub-microgram tolerance on a stated 500 g mass.
    expect(fins.overrideMass).toBe(0.5);
  });

  it.each(['rounded', 'airfoil'])('allows a moderate full-set freeform-fin override with %s profile', profile => {
    const tree = defaultTree();
    const body = tree.components[0]!.children!.find(n => n.type === 'bodytube')!;
    body.children!.push({ type: 'freeformfinset', id: 'free', name: 'Freeform fins', finCount: 3,
      crossSection: profile, thickness: 0.003, density: 630, overrideMass: 0.1,
      points: [[0, 0], [0.02, 0.055], [0.07, 0.045], [0.12, 0]] });
    expect(preflightAudit(tree, readAuditMasses(tree)).findings).not.toContainEqual(
      expect.objectContaining({ kind: 'mass-ratio', part: { id: 'free', name: 'Freeform fins' } }),
    );
  });

  it('leaves a seeded C6 flight byte-identical before and after the audit', () => {
    let tree = defaultTree();
    tree = updateNode(tree, tree.components[0]!.children![0]!.id!, { overrideMass: 0.025 });
    const flown = OrkRocket.buildTree(engineTree(tree));
    flown.setMotorById(motorMounts(tree)[0]!.id!, {
      designation: 'C6', diameter: 0.018, length: 0.07,
      times: [0, 0.2, 1.8], thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122], cgX: 0.035, ejectionDelay: 5,
    });
    flown.setRogersModifiedBarrowman(true);
    flown.setSupersonicAero(true);
    const options: SimulationOptions = { windAverage: 0, windStdDeviation: 0, randomSeed: 123, series: 'full' };
    const before = flown.simulate(options);
    expect(before.series.time.length).toBeGreaterThan(20);
    expect(before.series['Cdf']).toBeDefined();
    expect(before.series['tc']).toBeUndefined();
    preflightAudit(tree, readAuditMasses(tree));
    const after = flown.simulate(options);
    // Same-runtime differential comparison: no stored exact floating-point oracle.
    // TYPE_COMPUTATION_TIME is intentionally not in the engine's full series.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
