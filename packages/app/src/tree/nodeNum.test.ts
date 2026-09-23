import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { num, numOpt, numOrNull } from './nodeNum.js';
import { buildPieces } from './pieces.js';
import { fairingFrontalArea, mountRadiusOf, referenceArea } from './treeModel.js';
import { exportOrk } from '../services/orkFile.js';
import { exportRkt } from '../services/rocksimFile.js';
import { exportCdx1 } from '../services/rasaeroFile.js';
import { componentDxf } from '../services/dxfExport.js';
import { finOutline, finTemplateSvg } from '../services/finTemplate.js';

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
