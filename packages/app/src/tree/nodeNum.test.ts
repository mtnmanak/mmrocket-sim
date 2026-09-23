import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { num, numOpt, numOrNull } from './nodeNum.js';
import { buildPieces } from './pieces.js';
import {
  engineTree, fairingFrontalArea, findNode, inheritDefaults, makeNode, mountRadiusOf, referenceArea,
  splitClusterPairsTree, splitClusterTree, suppressingAncestor,
} from './treeModel.js';
import { componentLoop, finCutOutline } from './solidMesh.js';
import { solidContextFor } from './solidContext.js';
import { previewMounts, scaleRocket } from './scaleRocket.js';
import { autoAlignFinSets } from './finAlign.js';
import { exportOrk } from '../services/orkFile.js';
import { exportRkt } from '../services/rocksimFile.js';
import { exportCdx1 } from '../services/rasaeroFile.js';
import { componentDxf } from '../services/dxfExport.js';
import { finOutline, finTemplateSvg } from '../services/finTemplate.js';
import { canopyCdA, recoverySizing } from '../services/recoverySizing.js';
import { applyPresetLinks, holdsCatalogueMass, presetPatch, type Preset } from '../services/presets.js';
import { OVERRIDE_INCLUDES_MOTOR } from '../services/statedLaunchWeight.js';
import { componentTable } from '../services/componentTable.js';
import { coveringMassOverride, solePinnedStage } from '../services/buildAllowance.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { INITIAL_UNITS } from '../prefs/units.js';

const node = (fields: Record<string, unknown>): ComponentNode =>
  ({ type: 'bodytube', id: 'b', ...fields }) as ComponentNode;

describe('nodeNum — NaN is not a number the geometry layer can use', () => {
  it('falls back on NaN, which typeof calls a number', () => {
    // The whole bug in one line: `typeof NaN === 'number'` is true, so eleven
    // of the twelve local copies of this reader passed NaN straight through.
    expect(typeof NaN).toBe('number');
    expect(num(node({ length: NaN }), 'length', 0.3)).toBe(0.3);
    expect(numOpt(node({ length: NaN }), 'length')).toBeUndefined();
    expect(numOrNull(node({ length: NaN }), 'length')).toBeNull();
  });

  it('falls back on the infinities too', () => {
    expect(num(node({ length: Infinity }), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: -Infinity }), 'length', 0.3)).toBe(0.3);
  });

  it('passes a real number through, including zero and negatives', () => {
    // Zero must NOT fall back — a zero-length shoulder is a real value, and a
    // `|| fb` implementation would silently replace it.
    expect(num(node({ length: 0 }), 'length', 0.3)).toBe(0);
    expect(num(node({ offset: -0.05 }), 'offset', 0)).toBe(-0.05);
    expect(num(node({ length: 0.42 }), 'length', 0.3)).toBe(0.42);
  });

  it('falls back on a missing key and on a non-number', () => {
    expect(num(node({}), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: '0.4' }), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: null }), 'length', 0.3)).toBe(0.3);
  });
});

/**
 * The consequence, at the layer that shipped it. `buildPieces` feeds the 3D
 * view, `piecesToStl`, the OBJ export and the glTF export, so a non-finite
 * vertex here is a broken bounding sphere (no frustum culling, no raycast
 * picking) and an STL full of NaN facets written with no throw and no warning —
 * measured at 3,072 of 3,072 facets before the fix.
 */
describe('buildPieces emits only finite vertices from degenerate input', () => {
  const withNose = (fields: Record<string, unknown>): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage',
      id: 's',
      children: [
        { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.024, shape: 'ogive', ...fields } as ComponentNode,
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });

  const allFinite = (tree: RocketTree): boolean =>
    buildPieces(tree).pieces.every((p) => [...p.geometry.attributes['position']!.array]
      .every((v) => Number.isFinite(v)));

  it('survives a NaN radius — the case that wrote a 153,684-byte NaN STL', () => {
    // Math.max(0.0001, NaN) is NaN, so the radius floor meant to stop this
    // never did; the fix is upstream of the floor.
    expect(allFinite(withNose({ aftRadius: NaN }))).toBe(true);
  });

  it('survives a NaN length', () => {
    expect(allFinite(withNose({ length: NaN }))).toBe(true);
  });

  it('survives an Infinity dimension', () => {
    expect(allFinite(withNose({ aftRadius: Infinity }))).toBe(true);
  });

  it('survives a malformed freeform fin point list', () => {
    // `points` is read through a cast, not through `num`, so it needed its own
    // row check — solidMesh's finCutOutline already had one and returned null
    // for exactly this input while buildPieces produced 156 non-finite
    // vertices from it.
    const tree: RocketTree = {
      name: 't',
      components: [{
        type: 'stage',
        id: 's',
        children: [
          { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024,
            children: [{
              type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003,
              points: [[0, 0], 'oops', [0.05, 0.03], [0.05, 0]],
            } as unknown as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    expect(allFinite(tree)).toBe(true);
  });
});

/**
 * The local copies that outlived the 2026-09-08 consolidation: fourteen
 * `typeof n[key] === 'number' ? n[key] : fb` readers in the three design-file
 * writers, the DXF and fin-template exports, the reference-area and
 * camera-shroud lowering, and two views (audit 2026-09-22). Each now imports
 * this module, and eslint.config.mjs refuses a new one. One NaN field per
 * consumer, read through its former local reader, so each case failed
 * against the old copy and pins the fallback.
 */
describe('the consumers that carried their own reader fall back on NaN too', () => {
  const finTree = (fin: Record<string, unknown>, tube: Record<string, unknown> = {}): RocketTree => ({
    name: 'N',
    components: [{
      type: 'stage', id: 's', name: 'S',
      children: [
        { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.0125, thickness: 0.001, shape: 'ogive' },
        {
          type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.0125, thickness: 0.0005,
          children: [
            {
              type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.05, tipChord: 0.03,
              sweep: 0.02, height: 0.03, thickness: 0.003, ...fin,
            } as ComponentNode,
            {
              type: 'innertube', id: 'i', length: 0.07, outerRadius: 0.009, thickness: 0.0005, ...tube,
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });
  const finOf = (tree: RocketTree): ComponentNode => tree.components[0]!.children![1]!.children![0]!;

  it('.ork: a NaN root chord is written as the default, not <rootchord>NaN', () => {
    const xml = exportOrk({ name: 'N', tree: finTree({ rootChord: NaN }) });
    expect(xml).toContain('<rootchord>0.05</rootchord>');
    expect(xml).not.toContain('NaN');
  });

  it('.ork: a NaN angle goes through the degrees writer as its default', () => {
    // `deg` carried its own inline copy beside `n`.
    const xml = exportOrk({ name: 'N', tree: finTree({}, { radialDirection: NaN }) });
    expect(xml).toContain('<radialdirection>0.0000</radialdirection>');
    expect(xml).not.toContain('NaN');
  });

  it('.rkt: a NaN root chord is written as the default', () => {
    const xml = exportRkt({ name: 'N', tree: finTree({ rootChord: NaN }) });
    expect(xml).toContain('<RootChord>50</RootChord>');
    expect(xml).not.toContain('NaN');
  });

  it('.CDX1: a NaN root chord is written as the default', () => {
    expect(exportCdx1({ name: 'N', tree: finTree({ rootChord: NaN }) })).not.toContain('NaN');
  });

  it('the DXF label and the fin outline read the default, not NaN', () => {
    // The DXF cuts its outline through solidMesh (already on this module);
    // its own copy read the label's figures: "stock thickness NaN mm".
    expect(componentDxf(finOf(finTree({ thickness: NaN })), {}, 'N')!.text).not.toContain('NaN');
    const outline = finOutline(finOf(finTree({ rootChord: NaN })));
    expect(outline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  // ─── The INLINE reads in the same writers (2026-09-23) ───
  // Not readers of their own but the same test written in place — `typeof
  // node['cd'] === 'number' ? node['cd'] : 'auto'`, or `if (typeof
  // node['overrideMass'] === 'number')` around an emit — so the reader fold
  // above left them writing NaN. eslint.config.mjs now refuses both shapes
  // anywhere in the writer and cut-file modules.

  it('the fin template label reads the default count and omits a NaN thickness', () => {
    // Printed on the sheet a builder cuts from: "(cut NaN)", "thickness NaN mm".
    const svg = finTemplateSvg(finOf(finTree({ finCount: NaN, thickness: NaN })), 'N');
    expect(svg).toContain('(cut 3)');
    expect(svg).not.toContain('thickness');
    expect(svg).not.toContain('NaN');
  });

  it('.ork: the inline writes fall back as for an absent field', () => {
    const tree = finTree({ filletDensity: NaN }, { maxMotorLength: NaN, motorMount: true });
    const body = tree.components[0]!.children![1]!;
    body.children!.push(
      {
        type: 'parachute', id: 'p', diameter: 0.6, cd: NaN, surfaceDensity: NaN, lineDensity: NaN,
        overrideMass: NaN, overrideCGX: NaN, overrideCD: NaN,
      } as ComponentNode,
      { type: 'tubefinset', id: 't', finCount: 6, length: 0.05, outerRadius: NaN, thickness: 0.0005 } as ComponentNode,
    );
    tree.components[0]!.children!.push(
      { type: 'transition', id: 'x', length: 0.04, foreRadius: NaN, aftRadius: NaN, thickness: NaN } as ComponentNode,
    );
    tree.components.push({
      type: 'stage', id: 's2', name: 'Booster', separationDelay: NaN, separationAltitude: NaN,
      children: [{ type: 'bodytube', id: 'b2', length: 0.2, outerRadius: 0.0125, thickness: 0.0005 }],
    } as ComponentNode);
    const xml = exportOrk({ name: 'N', tree });
    expect(xml).toContain('<cd>auto</cd>');
    expect(xml).toContain('<foreradius>auto</foreradius>');
    expect(xml).toContain('<aftradius>auto</aftradius>');
    expect(xml).toContain('<radius>auto</radius>');
    expect(xml).toContain('<separationdelay>0</separationdelay>');
    expect(xml).toContain('group="Fabrics">Ripstop nylon</material>');
    expect(xml).not.toContain('<overridemass>');
    expect(xml).not.toContain('<overridecg>');
    expect(xml).not.toContain('<overridecd>');
    expect(xml).not.toContain('<maxmotorlength>');
    expect(xml).not.toContain('NaN');
  });

  it('.rkt: a NaN mass override writes the stated mass, and a NaN mount radius the default', () => {
    const tree = finTree({}, { outerRadius: NaN, motorMount: true });
    tree.components[0]!.children![1]!.children!.push(
      { type: 'masscomponent', id: 'm', mass: 0.05, length: 0.02, overrideMass: NaN, overrideCGX: NaN } as ComponentNode,
    );
    const xml = exportRkt({ name: 'N', tree });
    expect(xml).toContain('<KnownMass>50</KnownMass>');
    expect(xml).not.toContain('NaN');
  });

  it('the reference area and a shroud frontal area stay finite', () => {
    const tree = finTree({});
    const body = tree.components[0]!.children![1]!;
    body['outerRadius'] = NaN;
    // Math.max(maxR, NaN) is NaN, and every CD override is referenced to this area.
    expect(Number.isFinite(referenceArea(tree))).toBe(true);
    expect(mountRadiusOf(body)).toBe(0.012);
    body['outerRadius'] = 0.0125;
    const shroud = { type: 'fairing', id: 'c', width: NaN, height: 0.02 } as ComponentNode;
    body.children!.push(shroud);
    expect(Number.isFinite(fairingFrontalArea(tree, shroud))).toBe(true);
  });
});

/**
 * AUDIT ROW 522: the inline reads outside the writers. Every lone `typeof
 * x[k] === 'number'` left in src — the kernel lowering, recovery sizing, the
 * component table, the catalogue link, the cluster split, the Add defaults, the
 * scale preview — now reads through this module, and eslint.config.mjs refuses
 * the shape anywhere. Each case sets NaN or Infinity where the field was read,
 * and expects exactly what the same design gives with the field left out: the
 * kernel is handed null for a non-finite number (JSON.stringify) and falls back,
 * so "absent" is also what it flies.
 */
describe('the inline reads outside the writers fall back on NaN and Infinity too (audit row 522)', () => {
  const stageOf = (children: ComponentNode[], stage: Record<string, unknown> = {}): RocketTree => ({
    name: 'R',
    components: [{ type: 'stage', id: 's', name: 'S', ...stage, children } as ComponentNode],
  });
  const tube = (children: ComponentNode[] = [], fields: Record<string, unknown> = {}): ComponentNode => ({
    type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.05, thickness: 0.001, children, ...fields,
  } as ComponentNode);
  const nose: ComponentNode = { type: 'nosecone', id: 'n', length: 0.2, aftRadius: 0.05, thickness: 0.002, shape: 'ogive' };

  it('engineTree: a protuberance carrier is the one the absent fields give', () => {
    // protuberanceFrontalArea and the plate Cd: Math.max(0, NaN) is NaN, so a
    // NaN width, count or plate angle made the carrier's overrideCD NaN.
    const bump = (fields: Record<string, unknown>) => engineTree(stageOf([nose, tube([{
      type: 'protuberance', id: 'x', name: 'Bump', length: 0.03, mass: 0,
      position: { method: 'middle', offset: 0 }, ...fields,
    } as unknown as ComponentNode])]));
    for (const bad of [NaN, Infinity]) {
      expect(bump({ width: bad, height: bad, count: bad }), String(bad)).toEqual(bump({}));
      expect(bump({ dragClass: 'plate', plateAngle: bad }), String(bad)).toEqual(bump({ dragClass: 'plate' }));
    }
    const carrier = findNode(bump({ width: NaN }), 'x')!;
    expect(Number.isFinite(carrier['overrideCD'])).toBe(true);
    expect(Number.isFinite(carrier['overrideCDBodyRatio'])).toBe(true);
  });

  it('a NaN mass override suppresses nothing, as it overrides nothing in the kernel', () => {
    const tree = (overrideMass: number) => stageOf([nose, tube()], { overrideSubcomponentsMass: true, overrideMass });
    expect(suppressingAncestor(tree(0.4), 'b', 'overrideSubcomponentsMass', 'overrideMass')?.id).toBe('s');
    expect(solePinnedStage(tree(0.4).components)?.id).toBe('s');
    for (const bad of [NaN, Infinity]) {
      expect(suppressingAncestor(tree(bad), 'b', 'overrideSubcomponentsMass', 'overrideMass'), String(bad)).toBeNull();
      expect(solePinnedStage(tree(bad).components), String(bad)).toBeNull();
      expect(coveringMassOverride(tree(bad), 0.4, 0.02), String(bad)).toBeNull();
    }
    // The host tube itself, which coveringMassOverride tests before its ancestors.
    const hosted = (overrideMass: number) =>
      stageOf([nose, tube([], { overrideSubcomponentsMass: true, overrideMass })]);
    expect(coveringMassOverride(hosted(0.4), 0.4, 0.02)?.id).toBe('b');
    for (const bad of [NaN, Infinity]) {
      expect(coveringMassOverride(hosted(bad), 0.4, 0.02), String(bad)).toBeNull();
    }
  });

  it('a NaN stage override does not pin an empty canopy slot’s weight', () => {
    // recoverySizing's slotMassPinned: pinned, a candidate is rated at the
    // override's weight; unpinned, its own mass is weighed in (1.5 + 0.1 kg).
    const row = {
      kind: 'Parachute', manufacturer: 'Test', partNo: 'P-36', description: 'test canopy',
      diameter: 0.9144, dragCoefficient: 1.5, mass: 0.1,
    } as Preset;
    const rates = (stage: Record<string, unknown>) => {
      const r = recoverySizing({
        recovery: { state: 'ok', mass: 1.5, multiStage: false }, tree: stageOf([nose, tube()], stage),
        deviceMass: () => null, presets: [row], launch: DEFAULT_CONDITIONS,
      });
      if (r.state !== 'ok') throw new Error(r.state);
      return r.main.candidates.map((c) => c.rate);
    };
    expect(rates({})).toHaveLength(1);
    expect(rates({ overrideSubcomponentsMass: true, overrideMass: 1.5 })).not.toEqual(rates({}));
    for (const bad of [NaN, Infinity]) {
      expect(rates({ overrideSubcomponentsMass: true, overrideMass: bad }), String(bad)).toEqual(rates({}));
    }
  });

  it('the cluster split scales from the default, not from a NaN scale or rotation', () => {
    const split = (fields: Record<string, unknown>) => splitClusterTree(stageOf([tube([{
      type: 'innertube', id: 'm', length: 0.1, outerRadius: 0.012, thickness: 0.0005, cluster: '4-ring',
      motorMount: true, ...fields,
    } as ComponentNode])]), 'm')!;
    const groups = (s: ReturnType<typeof split>) => s.mountIds.map((id) => findNode(s.tree, id)!)
      .map((g) => [g['clusterScale'], g['clusterRotation']]);
    expect(groups(split({ clusterScale: NaN, clusterRotation: Infinity }))).toEqual(groups(split({})));
    expect(groups(split({}))[0]).toEqual([Math.SQRT2, Math.PI / 4]);
    // splitClusterPairsTree, a 6-ring's three pairs, reads them the same way.
    const pairs = (fields: Record<string, unknown>) => splitClusterPairsTree(stageOf([tube([{
      type: 'innertube', id: 'm', length: 0.1, outerRadius: 0.012, thickness: 0.0005, cluster: '6-ring',
      motorMount: true, ...fields,
    } as ComponentNode])]), 'm')!;
    expect(groups(pairs({ clusterScale: NaN, clusterRotation: Infinity }))).toEqual(groups(pairs({})));
    expect(groups(pairs({ clusterScale: 2 }))).not.toEqual(groups(pairs({})));
  });

  it('Add carries a finite radius and wall only', () => {
    // inheritDefaults' aftRadiusOf and wall copy: a NaN was copied onto the new part.
    const next = inheritDefaults(makeNode('bodytube'), 'stage',
      { ...tube(), aftRadius: NaN, outerRadius: 0.03, thickness: Infinity } as ComponentNode);
    expect(next['outerRadius']).toBe(0.03);
    expect(next['thickness']).toBe(makeNode('bodytube')['thickness']);
  });

  it('recovery sizing: a non-finite catalogue figure is an absent one', () => {
    const row = (fields: Record<string, unknown>): Preset => ({
      kind: 'Parachute', manufacturer: 'Test', partNo: 'P-36', description: 'test canopy',
      diameter: 0.9144, dragCoefficient: 1.5, mass: 0.1, ...fields,
    } as Preset);
    expect(canopyCdA(row({ diameter: Infinity }))).toBeNull();
    expect(canopyCdA(row({ dragCoefficient: NaN }))).toBeNull();
    expect(canopyCdA(row({ spillHoleDiameter: NaN }))).toBe(canopyCdA(row({})));
    expect(canopyCdA(row({ spillHoleDiameter: Infinity }))).toBe(canopyCdA(row({})));
    // The candidate line and its fit test.
    const tree = stageOf([nose, tube([{ type: 'parachute', id: 'p', diameter: 0.9, cd: 1.5 } as ComponentNode])]);
    const advice = (fields: Record<string, unknown>) => {
      const r = recoverySizing({
        recovery: { state: 'ok', mass: 1.5, multiStage: false }, tree, deviceMass: () => null,
        presets: [row(fields)], launch: DEFAULT_CONDITIONS,
      });
      if (r.state !== 'ok') throw new Error(r.state);
      return r.main.candidates;
    };
    expect(advice({})).toHaveLength(1);
    expect(advice({ packedDiameter: NaN, packedLength: Infinity, spillHoleDiameter: NaN })).toEqual(advice({}));
  });

  it('a NaN mass override is not the catalogue mass', () => {
    // It passed the typeof test, and a NaN difference is never greater than
    // the tolerance, so it read as the catalogue's own mass.
    const presets = [{ kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT-50', mass: 0.01 } as Preset];
    const linked = (overrideMass: number) => ({
      ...tube(), overrideMass, presetManufacturer: 'Estes', presetPartNo: 'BT-50',
    } as ComponentNode);
    expect(holdsCatalogueMass(linked(0.01), presets)).toBe(true);
    expect(holdsCatalogueMass(linked(NaN), presets)).toBe(false);
  });

  it('the component table leaves a blank, not "NaN"', () => {
    const table = componentTable(stageOf([nose, tube([], { length: NaN, outerRadius: Infinity })]),
      { units: INITIAL_UNITS, radiusMode: 'diameter' });
    expect(table.rows.flat().some((c) => typeof c === 'number' && !Number.isFinite(c))).toBe(false);
  });

  it('.rkt: a NaN override or shape parameter writes what the absent one writes', () => {
    // hasMassOv/hasCgOv were typeof tests OUTSIDE a conditional's test, which
    // the writer block's rule did not match: <KnownMass>NaN</KnownMass>.
    const xml = (fields: Record<string, unknown>, noseFields: Record<string, unknown> = {}) =>
      exportRkt({ name: 'R', tree: stageOf([{ ...nose, shape: 'power', ...noseFields }, tube([], fields)]) });
    for (const bad of [NaN, Infinity]) {
      expect(xml({ overrideMass: bad, overrideCGX: bad }), String(bad)).toBe(xml({}));
      expect(xml({}, { shapeParameter: bad }), String(bad)).toBe(xml({}));
    }
    expect(xml({ overrideMass: NaN })).not.toContain('NaN');
  });

  it('a freeform fin with a NaN point has no cut outline, like one with a string point', () => {
    const fin = (pts: unknown[]) =>
      ({ type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003, points: pts }) as unknown as ComponentNode;
    expect(finCutOutline(fin([[0, 0], [0.02, 0.03], [0.05, 0]]))).not.toBeNull();
    for (const bad of [NaN, Infinity]) {
      expect(finCutOutline(fin([[0, 0], [0.02, bad], [0.05, 0]])), String(bad)).toBeNull();
      expect(componentDxf(fin([[0, 0], [0.02, bad], [0.05, 0]]), {}, 'R')?.text ?? '', String(bad)).not.toContain('NaN');
    }
  });

  it('the scale preview reads a non-finite motor diameter as no motor', () => {
    const tree = stageOf([tube([{
      type: 'innertube', id: 'm', length: 0.1, outerRadius: 0.0145, thickness: 0.0005, motorMount: true,
    } as ComponentNode])]);
    for (const bad of [NaN, Infinity]) {
      expect(previewMounts(tree, 2, { assignedMotorDiameters: { m: bad } }), String(bad))
        .toEqual(previewMounts(tree, 2, {}));
    }
  });

  it('.rkt: a NaN override on a base extension folds it back, as an absent one does', () => {
    // exportRkt's foldChain tested these with typeof, so a NaN or infinite one
    // kept the extension out of <BaseExtensionLen> as a second <BodyTube>
    // (review of audit row 522).
    const xml = (fields: Record<string, unknown>) => exportRkt({ name: 'R', tree: stageOf([nose, {
      type: 'bodytube', id: 'x', length: 0.03, outerRadius: 0.05, thickness: 0.002, rktBaseExtension: true,
      ...fields,
    } as ComponentNode, tube()]) });
    expect(xml({})).toContain('<BaseExtensionLen>30</BaseExtensionLen>');
    for (const bad of [NaN, Infinity]) {
      for (const key of ['overrideMass', 'overrideCGX', 'overrideCD']) {
        expect(xml({ [key]: bad }), `${key} ${bad}`).toBe(xml({}));
      }
    }
    // A finite override still keeps the tube whole: the fold would drop it.
    expect(xml({ overrideCD: 0.5 })).not.toBe(xml({}));
  });

  it('a NaN weighing is no assembly to keep: the new part’s catalogue mass lands', () => {
    // presetPatch's `held`: a weighed assembly keeps its weighing across a
    // change of part; a NaN is not a weighing.
    const row = {
      kind: 'BodyTube', manufacturer: 'Test', partNo: 'BT-1', description: '', mass: 0.02,
      outsideDiameter: 0.1, insideDiameter: 0.098,
    } as Preset;
    const patch = (prior: Record<string, unknown>) =>
      presetPatch('bodytube', row, { node: tube([], prior), presets: [] });
    expect(patch({ overrideSubcomponentsMass: true, overrideMass: 0.4 })['overrideMass']).toBeUndefined();
    expect(patch({ overrideSubcomponentsMass: true })['overrideMass']).toBe(0.02);
    for (const bad of [NaN, Infinity]) {
      expect(patch({ overrideSubcomponentsMass: true, overrideMass: bad }), String(bad))
        .toEqual(patch({ overrideSubcomponentsMass: true }));
    }
  });

  it('a NaN wall is not a statement that a nose is hollow', () => {
    // applyPresetLinks' statesHollow: a wall keeps the catalogue's `filled: true`
    // off the part; a NaN one says nothing, like no wall at all.
    const row = { kind: 'NoseCone', manufacturer: 'Test', partNo: 'NC-1', description: '', filled: true } as Preset;
    const filled = (fields: Record<string, unknown>) => {
      const n = { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.02, shape: 'ogive', ...fields } as ComponentNode;
      applyPresetLinks([{ node: n, manufacturer: 'Test', partNo: 'NC-1' }], [row], []);
      return n['filled'];
    };
    expect(filled({ thickness: 0.002 })).toBeUndefined();
    expect(filled({})).toBe(true);
    for (const bad of [NaN, Infinity]) expect(filled({ thickness: bad }), String(bad)).toBe(true);
  });

  it('the print/cut context takes no mount radius from a NaN one', () => {
    const ctx = (fields: Record<string, unknown>) => {
      const tree = stageOf([nose, tube([
        { type: 'centeringring', id: 'r', length: 0.005 } as ComponentNode,
        { type: 'innertube', id: 'm', length: 0.1, thickness: 0.0005, ...fields } as ComponentNode,
      ])]);
      return solidContextFor(tree, findNode(tree, 'r')!);
    };
    expect(ctx({ outerRadius: 0.012 }).mountOuterRadius).toBe(0.012);
    for (const bad of [NaN, Infinity]) expect(ctx({ outerRadius: bad }), String(bad)).toEqual(ctx({}));
  });

  it('a nose cone’s NaN shape parameter cuts the default profile', () => {
    const loop = (fields: Record<string, unknown>) =>
      componentLoop({ ...nose, shape: 'power', ...fields } as ComponentNode, {});
    expect(loop({ shapeParameter: 0.3 })).not.toEqual(loop({}));
    for (const bad of [NaN, Infinity]) expect(loop({ shapeParameter: bad }), String(bad)).toEqual(loop({}));
  });

  it('scaling a marked stage with a NaN mass override says it lost the CG, not the mass', () => {
    const notes = (fields: Record<string, unknown>) => scaleRocket(stageOf([nose, tube()], {
      [OVERRIDE_INCLUDES_MOTOR]: 'M787', overrideCGX: 0.3, overrideSubcomponentsCG: true,
      overrideSubcomponentsMass: true, ...fields,
    }), 2).notes;
    expect(notes({ overrideMass: 2 }).join(' ')).toContain('lost the mass and CG');
    for (const bad of [NaN, Infinity]) expect(notes({ overrideMass: bad }), String(bad)).toEqual(notes({}));
  });

  it('fin alignment spans the fins on a NaN-length tube as on one with no length', () => {
    // autoAlignFinSets' parent length: NaN spans overlap nothing, so two
    // aft-mounted sets on the same tube were left fin on fin.
    const fins = (id: string) => ({ ...makeNode('trapezoidfinset'), id }) as ComponentNode;
    const changes = (length: number | undefined) =>
      autoAlignFinSets(stageOf([nose, tube([fins('f1'), fins('f2')], { length })])).changes;
    expect(changes(undefined)).toHaveLength(1);
    for (const bad of [NaN, Infinity]) expect(changes(bad), String(bad)).toEqual(changes(undefined));
  });
});
