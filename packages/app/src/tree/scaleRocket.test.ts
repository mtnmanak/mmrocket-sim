import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket } from '@online-openrocket/engine';
import {
  maxBodyDiameter, mountBore, previewMounts, rocketLength, scaleRocket,
} from './scaleRocket.js';
import { engineTree, findNode } from './treeModel.js';
import { axialLength, startFromPosition } from './position.js';
import { FIELDS } from './schema.js';

/**
 * A design carrying EVERY component type, with every length-valued key on each
 * one set to a distinct, recognisable number. The completeness guard below
 * scales this and checks key by key what moved — which is the only way to
 * catch a key the scaler forgot AND a key it should not have touched.
 */
const kitchenSink = (): RocketTree => ({
  name: 'sink',
  components: [{
    type: 'stage', id: 'st', nozzleExitDiameter: 0.03, separationAltitude: 300,
    children: [
      {
        type: 'nosecone', id: 'nc', length: 0.3, aftRadius: 0.05, thickness: 0.002,
        shape: 'ogive', shapeParameter: 0.6, finish: 'polished', density: 680,
        shoulderRadius: 0.048, shoulderLength: 0.04, shoulderThickness: 0.0015,
        overrideMass: 0.2, overrideCGX: 0.12,
      } as ComponentNode,
      {
        type: 'transition', id: 'tr', length: 0.1, foreRadius: 0.05, aftRadius: 0.038,
        thickness: 0.002, shapeParameter: 0.5,
        foreShoulderRadius: 0.048, foreShoulderLength: 0.03, foreShoulderThickness: 0.0015,
        aftShoulderRadius: 0.036, aftShoulderLength: 0.03, aftShoulderThickness: 0.0015,
        position: { method: 'top', offset: 0.01 },
      } as ComponentNode,
      {
        type: 'bodytube', id: 'bt', length: 0.9, outerRadius: 0.05, thickness: 0.0015,
        motorOverhang: 0.006, density: 1850, finish: 'normal',
        children: [
          {
            type: 'trapezoidfinset', id: 'tf', finCount: 4, rootChord: 0.2, tipChord: 0.08,
            sweep: 0.12, height: 0.11, thickness: 0.004, cant: 0.02, rotation: 0.5,
            crossSection: 'rounded', airfoilLeDiamond: 0.02, airfoilTeDiamond: 0.03,
            finLeRadius: 0.001, tabHeight: 0.01, tabLength: 0.06, tabOffset: 0.005,
            filletRadius: 0.003, position: { method: 'bottom', offset: -0.02 },
          } as ComponentNode,
          {
            type: 'freeformfinset', id: 'ff', finCount: 3, thickness: 0.003,
            points: [[0, 0], [0.02, 0.03], [0.045, 0.03], [0.05, 0]],
            tabHeight: 0.008, tabLength: 0.03, tabOffset: 0.002, filletRadius: 0.002,
            airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.012, finLeRadius: 0.0008,
            position: { method: 'middle', offset: 0.03 },
          } as ComponentNode,
          {
            type: 'ellipticalfinset', id: 'ef', finCount: 3, rootChord: 0.09, height: 0.05,
            thickness: 0.003, cant: 0.01, tabHeight: 0.006, tabLength: 0.02, tabOffset: 0.001,
            filletRadius: 0.001, airfoilLeDiamond: 0.008, airfoilTeDiamond: 0.009,
            finLeRadius: 0.0005, position: { method: 'top', offset: 0.4 },
          } as ComponentNode,
          {
            type: 'tubefinset', id: 'tu', finCount: 6, length: 0.12, outerRadius: 0.02,
            thickness: 0.001, position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          {
            type: 'innertube', id: 'mm', length: 0.42, outerRadius: 0.0285, thickness: 0.0008,
            motorMount: true, motorOverhang: 0.006, maxMotorLength: 0.5,
            radialPosition: 0.01, radialDirection: 1.2, cluster: 'single',
            clusterScale: 1.5, clusterRotation: 0.3,
            position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          {
            type: 'tubecoupler', id: 'tc', length: 0.1, thickness: 0.0015,
            outerRadius: 0.047, innerRadius: 0.045,
            position: { method: 'top', offset: 0.2 },
          } as ComponentNode,
          {
            type: 'centeringring', id: 'cr', length: 0.005, outerRadius: 0.047,
            innerRadius: 0.0285, instanceSeparation: 0.15,
            position: { method: 'top', offset: 0.3 },
          } as ComponentNode,
          {
            type: 'bulkhead', id: 'bh', length: 0.006, outerRadius: 0.047,
            instanceSeparation: 0.2, position: { method: 'top', offset: 0.5 },
          } as ComponentNode,
          {
            type: 'engineblock', id: 'eb', length: 0.005, thickness: 0.002,
            outerRadius: 0.028, position: { method: 'top', offset: 0.6 },
          } as ComponentNode,
          {
            type: 'launchlug', id: 'll', length: 0.05, outerRadius: 0.005, thickness: 0.0008,
            instanceSeparation: 0.3, angleOffset: 3.14,
            position: { method: 'top', offset: 0.7 },
          } as ComponentNode,
          {
            type: 'railbutton', id: 'rb', outerDiameter: 0.0102, instanceCount: 2,
            // v0.103 gave the button its other five dimensions. They are
            // catalogue hardware like the diameter, so none of them scales.
            innerDiameter: 0.0058, totalHeight: 0.00756,
            baseHeight: 0.00185, flangeHeight: 0.00185, screwHeight: 0.0018,
            instanceSeparation: 0.4, angleOffset: 3.14,
            position: { method: 'top', offset: 0.75 },
          } as ComponentNode,
          {
            type: 'parachute', id: 'pc', diameter: 0.9, cd: 0.8, spillHoleDiameter: 0.1,
            lineCount: 8, lineLength: 0.7, deployEvent: 'altitudedescending',
            deployAltitude: 150, deployDelay: 1,
            position: { method: 'top', offset: 0.1 },
          } as ComponentNode,
          {
            type: 'streamer', id: 'sm', stripLength: 0.8, stripWidth: 0.08, cd: 0.6,
            deployAltitude: 120, position: { method: 'top', offset: 0.15 },
          } as ComponentNode,
          {
            type: 'shockcord', id: 'sc', cordLength: 3, position: { method: 'top', offset: 0.2 },
          } as ComponentNode,
          {
            type: 'masscomponent', id: 'mc', mass: 0.12, length: 0.06, radius: 0.02,
            radialPosition: 0.005, radialDirection: 0.7,
            position: { method: 'top', offset: 0.25 },
          } as ComponentNode,
          {
            type: 'fairing', id: 'fa', length: 0.11, width: 0.041, height: 0.033,
            mass: 0.09, angleOffset: 1.57, conformal: true,
            position: { method: 'top', offset: 0.35 },
          } as ComponentNode,
          {
            type: 'protuberance', id: 'pr', width: 0.02, height: 0.01, length: 0.03,
            count: 2, mass: 0.01, cdFrontal: 0.6, angleOffset: 0.8,
            position: { method: 'top', offset: 0.45 },
            // 'protuberance' is app-only — the kernel never sees it (engineTree
            // lowers it), so it is not in the engine's ComponentType union.
          } as unknown as ComponentNode,
          {
            type: 'podset', id: 'pd', instanceCount: 2, radiusOffset: 0.02,
            angleOffset: 1.0, position: { method: 'top', offset: 0.55 },
            children: [
              { type: 'bodytube', id: 'pdt', length: 0.2, outerRadius: 0.02, thickness: 0.001 } as ComponentNode,
            ],
          } as ComponentNode,
          {
            // A parallel booster as well as a pod. The schema-coverage check
            // matches a key on ANY type, so without a real parallelstage node
            // here a scaler that forgot it would still pass that guard.
            type: 'parallelstage', id: 'ps', instanceCount: 2, radiusOffset: 0.03,
            angleOffset: 0.5, separationAltitude: 250,
            position: { method: 'top', offset: 0.65 },
            children: [
              { type: 'bodytube', id: 'pst', length: 0.25, outerRadius: 0.022, thickness: 0.001 } as ComponentNode,
            ],
          } as ComponentNode,
        ],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

const K = 2.5;

/** Every numeric leaf in the tree, addressed as "<id>.<key>" (+ position offsets, points). */
function numericLeaves(tree: RocketTree): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      const id = n.id ?? '?';
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === 'number') out.set(`${id}.${k}`, v);
      }
      if (n.position && typeof n.position.offset === 'number') {
        out.set(`${id}.position.offset`, n.position.offset);
      }
      const pts = n['points'];
      if (Array.isArray(pts)) {
        pts.forEach((p, i) => {
          if (Array.isArray(p)) {
            out.set(`${id}.points[${i}][0]`, p[0] as number);
            out.set(`${id}.points[${i}][1]`, p[1] as number);
          }
        });
      }
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return out;
}

describe('scaleRocket — the completeness guard', () => {
  const before = numericLeaves(kitchenSink());
  const after = numericLeaves(scaleRocket(kitchenSink(), K).tree);

  /**
   * The exhaustive expectation. Anything scaled must be here; anything here
   * must be scaled. Written out rather than derived from the same LENGTH_KEYS
   * table the implementation uses — a test that reads its own subject's
   * configuration cannot catch a wrong entry in it.
   */
  const SCALED = new Set([
    'nc.length', 'nc.aftRadius', 'nc.thickness',
    'nc.shoulderRadius', 'nc.shoulderLength', 'nc.shoulderThickness',
    'nc.overrideCGX',
    'tr.length', 'tr.foreRadius', 'tr.aftRadius', 'tr.thickness',
    'tr.foreShoulderRadius', 'tr.foreShoulderLength', 'tr.foreShoulderThickness',
    'tr.aftShoulderRadius', 'tr.aftShoulderLength', 'tr.aftShoulderThickness',
    'tr.position.offset',
    'bt.length', 'bt.outerRadius', 'bt.thickness',
    'tf.rootChord', 'tf.tipChord', 'tf.sweep', 'tf.height', 'tf.thickness',
    'tf.airfoilLeDiamond', 'tf.airfoilTeDiamond', 'tf.finLeRadius',
    'tf.tabHeight', 'tf.tabLength', 'tf.tabOffset', 'tf.filletRadius', 'tf.position.offset',
    'ff.thickness', 'ff.tabHeight', 'ff.tabLength', 'ff.tabOffset', 'ff.filletRadius',
    'ff.airfoilLeDiamond', 'ff.airfoilTeDiamond', 'ff.finLeRadius', 'ff.position.offset',
    'ff.points[0][0]', 'ff.points[0][1]', 'ff.points[1][0]', 'ff.points[1][1]',
    'ff.points[2][0]', 'ff.points[2][1]', 'ff.points[3][0]', 'ff.points[3][1]',
    'ef.rootChord', 'ef.height', 'ef.thickness', 'ef.tabHeight', 'ef.tabLength',
    'ef.tabOffset', 'ef.filletRadius', 'ef.airfoilLeDiamond', 'ef.airfoilTeDiamond',
    'ef.finLeRadius', 'ef.position.offset',
    'tu.length', 'tu.outerRadius', 'tu.thickness',
    'mm.length', 'mm.outerRadius', 'mm.thickness', 'mm.radialPosition', 'mm.maxMotorLength',
    'tc.length', 'tc.thickness', 'tc.outerRadius', 'tc.innerRadius', 'tc.position.offset',
    'cr.length', 'cr.outerRadius', 'cr.innerRadius', 'cr.instanceSeparation', 'cr.position.offset',
    'bh.length', 'bh.outerRadius', 'bh.instanceSeparation', 'bh.position.offset',
    'eb.length', 'eb.thickness', 'eb.outerRadius', 'eb.position.offset',
    'll.length', 'll.instanceSeparation', 'll.position.offset',
    'rb.instanceSeparation', 'rb.position.offset',
    'pc.diameter', 'pc.spillHoleDiameter', 'pc.lineLength', 'pc.position.offset',
    'sm.stripLength', 'sm.stripWidth', 'sm.position.offset',
    'sc.cordLength', 'sc.position.offset',
    'mc.length', 'mc.radius', 'mc.radialPosition', 'mc.position.offset',
    'fa.position.offset',
    'pr.width', 'pr.height', 'pr.length', 'pr.position.offset',
    'pd.radiusOffset', 'pd.position.offset',
    'pdt.length', 'pdt.outerRadius', 'pdt.thickness',
    'ps.radiusOffset', 'ps.position.offset',
    'pst.length', 'pst.outerRadius', 'pst.thickness',
  ]);
  /** Masses go as the CUBE — they are lengths cubed, not lengths. */
  const CUBED = new Set(['nc.overrideMass', 'mc.mass', 'pr.mass']);

  it('scales exactly the keys it should, and nothing else', () => {
    const movedLinear: string[] = [];
    const movedCubed: string[] = [];
    const unchanged: string[] = [];
    for (const [key, v0] of before) {
      const v1 = after.get(key)!;
      if (v0 === 0) continue; // 0 scales to 0; carries no information either way
      const ratio = v1 / v0;
      if (Math.abs(ratio - K) < 1e-9) movedLinear.push(key);
      else if (Math.abs(ratio - K ** 3) < 1e-9) movedCubed.push(key);
      else if (v1 === v0) unchanged.push(key);
      else throw new Error(`${key} moved by an unexpected ratio ${ratio} (${v0} -> ${v1})`);
    }
    expect(movedLinear.sort()).toEqual([...SCALED].filter((k) => before.get(k) !== 0).sort());
    expect(movedCubed.sort()).toEqual([...CUBED].sort());
    // Everything else stayed put — spot the ones that would be defects.
    for (const key of [
      'st.nozzleExitDiameter', 'st.separationAltitude',
      'nc.shapeParameter', 'nc.density', 'tf.cant', 'tf.rotation', 'tf.finCount',
      'mm.clusterScale', 'mm.clusterRotation', 'mm.radialDirection', 'mm.motorOverhang',
      'bt.motorOverhang', 'bt.density', 'pc.cd', 'pc.deployAltitude', 'pc.deployDelay',
      'pc.lineCount', 'sm.deployAltitude', 'sm.cd', 'll.outerRadius', 'll.thickness',
      'll.angleOffset', 'rb.outerDiameter', 'rb.instanceCount', 'rb.angleOffset',
      'rb.innerDiameter', 'rb.totalHeight', 'rb.baseHeight', 'rb.flangeHeight',
      'rb.screwHeight',
      'fa.length', 'fa.width', 'fa.height', 'fa.mass', 'fa.angleOffset',
      'pr.count', 'pr.cdFrontal', 'pr.angleOffset', 'mc.radialDirection',
      'pd.instanceCount', 'pd.angleOffset', 'ef.cant', 'ff.finCount',
      'ps.instanceCount', 'ps.angleOffset', 'ps.separationAltitude',
    ]) {
      expect(unchanged, key).toContain(key);
    }
  });

  it('leaves every AUTOMATIC dimension absent — absence is a value in this tree', () => {
    // An absent transition radius means "copy the neighbour", an absent ring
    // radius means "size yourself off the parent", an absent tube-fin radius
    // means the touching-circle formula. `k × (v ?? default)` would freeze all
    // three into explicit numbers and change the design.
    const autos: RocketTree = {
      name: 'auto',
      components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.04, children: [
            { type: 'transition', id: 't', length: 0.05 } as ComponentNode,
            { type: 'centeringring', id: 'c', length: 0.005 } as ComponentNode,
            { type: 'tubefinset', id: 'u', finCount: 6, length: 0.1 } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    const out = scaleRocket(autos, 3).tree;
    for (const [id, key] of [['t', 'foreRadius'], ['t', 'aftRadius'],
      ['c', 'outerRadius'], ['c', 'innerRadius'], ['u', 'outerRadius']] as const) {
      expect(findNode(out, id)![key], `${id}.${key}`).toBeUndefined();
    }
    expect(findNode(out, 't')!['length']).toBeCloseTo(0.15, 12);
  });

  it('covers every mm/m field the schema declares, or names why not', () => {
    // Drift alarm: if a new length field is added to schema.ts and not to the
    // scaler, this fails and names it. The exemptions are the four lengths
    // that are not rocket geometry.
    const EXEMPT = new Set([
      'deployAltitude',   // an altitude AGL, not a dimension
      'motorOverhang',    // how far the MOTOR sticks out — motor-referenced
      'nozzleExitDiameter', // the motor's nozzle
    ]);
    const missing: string[] = [];
    for (const [type, defs] of Object.entries(FIELDS)) {
      for (const f of defs) {
        if (f.unit !== 'mm' && f.unit !== 'm') continue;
        if (EXEMPT.has(f.key)) continue;
        // fairing is fixed-size hardware; launchlug's radius is the rod's.
        if (type === 'fairing') continue;
        if (type === 'launchlug' && f.key !== 'length' && f.key !== 'instanceSeparation') continue;
        // A rail button is a CATALOGUE part — micro / mini / 1010 / 1515 /
        // unistrut — and the rail it rides does not scale with the airframe, so
        // none of its six dimensions does either (railbutton is in FIXED_SIZE).
        // Only the SPAN between a pair is an airframe dimension. This clause
        // replaced a bare 'outerDiameter' exemption when v0.103 gave the button
        // its other five dimensions; stating the rule once is what keeps the
        // next five from being exempted one at a time without anyone deciding.
        if (type === 'railbutton' && f.key !== 'instanceSeparation') continue;
        const hit = [...SCALED].some((s) => s.endsWith(`.${f.key}`));
        if (!hit) missing.push(`${type}.${f.key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('scaleRocket — what Eric ruled does not scale', () => {
  it('a camera shroud keeps its size and its mass, and only moves', () => {
    const out = scaleRocket(kitchenSink(), K).tree;
    const fa = findNode(out, 'fa')!;
    expect(fa['length']).toBe(0.11);
    expect(fa['width']).toBe(0.041);
    expect(fa['height']).toBe(0.033);
    expect(fa['mass']).toBe(0.09); // same part, same weight
    expect(fa.position!.offset).toBeCloseTo(0.35 * K, 12);
  });

  it('a rail button keeps ALL SIX of its dimensions; only the pair spacing scales', () => {
    const out = scaleRocket(kitchenSink(), K).tree;
    const rb = findNode(out, 'rb')!;
    expect(rb['outerDiameter']).toBe(0.0102); // 1010 stays 1010
    // v0.103: the other five are catalogue hardware too. A scaled airframe
    // still bolts to the same rail, so a 1010 button on a 2x rocket is still a
    // 1010 button — the drag and mass this now drives must not grow with it.
    expect(rb['innerDiameter']).toBe(0.0058);
    expect(rb['totalHeight']).toBe(0.00756);
    expect(rb['baseHeight']).toBe(0.00185);
    expect(rb['flangeHeight']).toBe(0.00185);
    expect(rb['screwHeight']).toBe(0.0018);
    expect(rb['instanceCount']).toBe(2);
    expect(rb['instanceSeparation']).toBeCloseTo(0.4 * K, 12);
  });

  it('a launch lug keeps its bore — that is the rod — but its length scales', () => {
    const out = scaleRocket(kitchenSink(), K).tree;
    const ll = findNode(out, 'll')!;
    expect(ll['outerRadius']).toBe(0.005);
    expect(ll['thickness']).toBe(0.0008);
    expect(ll['length']).toBeCloseTo(0.05 * K, 12);
  });
});

describe('scaleRocket — the geometry really is similar', () => {
  /** Absolute station of a child's leading edge, in the parent's frame. */
  const station = (tree: RocketTree, parentId: string, childId: string): number => {
    const p = findNode(tree, parentId)!;
    const c = findNode(tree, childId)!;
    const pLen = p['length'] as number;
    // axialLength, not `length`: a freeform fin's extent is max(points[i][0]),
    // and using the wrong one here would let a broken `points` scale pass.
    const cLen = axialLength(c);
    return startFromPosition(c.position!, cLen, pLen);
  };

  it('every part lands at k× its old station, in all four position methods', () => {
    const base = kitchenSink();
    const out = scaleRocket(base, K).tree;
    // 'top' (eb), 'middle' (ff), 'bottom' (tf) — the three the fixture uses on
    // parts that carry a length the scaler also moved.
    for (const id of ['eb', 'tc', 'cr', 'bh']) {
      expect(station(out, 'bt', id), id).toBeCloseTo(K * station(base, 'bt', id), 12);
    }
    for (const id of ['tf', 'ff']) {
      expect(station(out, 'bt', id), id).toBeCloseTo(K * station(base, 'bt', id), 12);
    }
  });

  it('scaling by k then by 1/k returns the original design', () => {
    const base = kitchenSink();
    const round = scaleRocket(scaleRocket(base, 4).tree, 0.25).tree;
    const a = numericLeaves(base);
    const b = numericLeaves(round);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) {
      expect(b.get(k)!, k).toBeCloseTo(v, 10);
    }
  });

  it('recovery gear is fabric and line, so it does NOT go as the cube', () => {
    // The app's own default rocket, and the reason the claim above has to be
    // qualified. Every solid part goes as k^3 because its density is unchanged;
    // a canopy is a SURFACE density and shroud lines are a LINE density, so
    // they go as k^2 and k. Measured against the real kernel, not asserted from
    // this module's arithmetic.
    const dflt: RocketTree = {
      name: 'default', components: [{
        type: 'stage', id: 's', children: [
          { type: 'nosecone', id: 'n', length: 0.14, aftRadius: 0.024, thickness: 0.004 } as ComponentNode,
          {
            type: 'bodytube', id: 'b', length: 0.6, outerRadius: 0.024, thickness: 0.0006,
            density: 950,
            children: [
              {
                type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.1, tipChord: 0.06,
                sweep: 0.04, height: 0.06, thickness: 0.006,
                position: { method: 'bottom', offset: 0 },
              } as ComponentNode,
              {
                type: 'innertube', id: 'm', length: 0.14, outerRadius: 0.019, thickness: 0.001,
                motorMount: true, position: { method: 'bottom', offset: 0 },
              } as ComponentNode,
              { type: 'parachute', id: 'p', diameter: 0.3, position: { method: 'top', offset: 0.1 } } as ComponentNode,
            ],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const massOf = (t: RocketTree, id: string) =>
      OrkRocket.buildTree(engineTree(t)).componentInfo(id).mass;
    const two = scaleRocket(dflt, 2).tree;
    // Solid structure: exactly the cube.
    for (const id of ['n', 'b', 'f', 'm']) {
      expect(massOf(two, id) / massOf(dflt, id), id).toBeCloseTo(8, 9);
    }
    // The canopy is not, and this is the number that makes the point.
    const chute = massOf(two, 'p') / massOf(dflt, 'p');
    expect(chute).toBeGreaterThan(2);
    expect(chute).toBeLessThan(4);
    expect(massOf(dflt, 'p') * 1000).toBeCloseTo(7.976, 2);
    expect(massOf(two, 'p') * 1000).toBeCloseTo(22.184, 2);
    // …so the margin moves, a little, and the notes say so.
    const notes = scaleRocket(dflt, 2).notes.join(' ');
    expect(notes).toContain('does NOT go as the cube');
    expect(notes).toContain('1.41x as fast');
  });

  it('preserves stability in calibers — the invariant a scale model is defined by', () => {
    // Chuck Rogers' own definition of a scale model, and the Apogee article's:
    // photographically scaled, with CG and CP at the same percentage of body
    // length. That falls out of geometry + constant density, and it is the
    // strongest end-to-end check available — it goes through the real kernel,
    // not through this module's arithmetic.
    //
    // NOTE THE FIXTURE HAS NO PARACHUTE, and that is not an accident: recovery
    // gear is fabric, breaks exact similarity, and is pinned by the test above.
    // Structure alone is where the invariant is exact.
    const simple: RocketTree = {
      name: 'simple',
      components: [{
        type: 'stage', id: 's', children: [
          { type: 'nosecone', id: 'n', length: 0.25, aftRadius: 0.026, thickness: 0.002, shape: 'ogive' } as ComponentNode,
          {
            type: 'bodytube', id: 'b', length: 0.8, outerRadius: 0.026, thickness: 0.0015,
            children: [
              {
                type: 'trapezoidfinset', id: 'f', finCount: 4, rootChord: 0.18, tipChord: 0.07,
                sweep: 0.1, height: 0.09, thickness: 0.004, crossSection: 'rounded',
                position: { method: 'bottom', offset: 0 },
              } as ComponentNode,
              {
                type: 'innertube', id: 'm', length: 0.3, outerRadius: 0.0145, thickness: 0.0008,
                motorMount: true, position: { method: 'bottom', offset: 0 },
              } as ComponentNode,
            ],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const statOf = (t: RocketTree) => {
      const r = OrkRocket.buildTree(engineTree(t));
      const info = r.staticInfo();
      return info;
    };
    const a = statOf(simple);
    const b = statOf(scaleRocket(simple, 3).tree);

    // CP and CG both scale by exactly 3 …
    // Relative, not absolute: these are metres on a 2 m rocket, so 9 decimal
    // places is a tolerance the kernel's own summation order cannot meet. 1e-8
    // RELATIVE is the real claim, and it is ~10^5 tighter than the last digit
    // any screen in the app prints.
    const ratio = (x: number, y: number) => Math.abs(x / y - 1);
    expect(ratio(b.cp, a.cp * 3)).toBeLessThan(1e-8);
    expect(ratio(b.cgEmpty, a.cgEmpty * 3)).toBeLessThan(1e-8);
    expect(ratio(b.length, a.length * 3)).toBeLessThan(1e-8);
    expect(ratio(b.refDiameter, a.refDiameter * 3)).toBeLessThan(1e-8);
    // … so the margin in calibers is unchanged, and CNa (dimensionless) too.
    expect(Math.abs(b.cna / a.cna - 1)).toBeLessThan(1e-8);
    // Stated as a RELATIVE tolerance: the two calibers figures come out of the
    // kernel through different-sized arithmetic, so they agree to 9 significant
    // figures rather than to 9 decimal places. 1e-8 relative is still ~4000x
    // tighter than any change a user could notice.
    const cal = (s: typeof a) => (s.cp - s.cgEmpty) / s.refDiameter;
    expect(Math.abs(cal(b) / cal(a) - 1)).toBeLessThan(1e-8);
    // CP as a percentage of body length — Chuck Rogers' own wording.
    expect(ratio(b.cp / b.length, a.cp / a.length)).toBeLessThan(1e-8);
    // Mass goes as the cube, because density did not move.
    expect(ratio(b.massEmpty, a.massEmpty * 27)).toBeLessThan(1e-8);
  });
});

describe('scaleRocket — motor mounts', () => {
  const withMount = (bore: number): RocketTree => ({
    name: 'm',
    components: [{
      type: 'stage', id: 's', children: [{
        type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, thickness: 0.0015,
        children: [{
          type: 'innertube', id: 'mt', length: 0.2, outerRadius: bore / 2 + 0.0008,
          thickness: 0.0008, motorMount: true, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('reports the Apogee case: 18 mm scaled 2.27× is not a motor you can buy', () => {
    const [p] = previewMounts(withMount(0.018), 2.27);
    expect(p!.boreMm).toBeCloseTo(18, 6);
    expect(p!.scaledBoreMm).toBeCloseTo(40.86, 2);
    expect(p!.nearestMm).toBe(38);
  });

  it('snapping keeps the wall and puts the bore exactly on the standard size', () => {
    const t = withMount(0.018);
    const out = scaleRocket(t, 2.27, { snapMounts: true }).tree;
    const mt = findNode(out, 'mt')!;
    expect(mountBore(mt) * 1000).toBeCloseTo(38, 9);
    expect(mt['thickness']).toBeCloseTo(0.0008 * 2.27, 12); // wall scaled, then kept
  });

  it('without snapping the mount is the true geometric scale', () => {
    const out = scaleRocket(withMount(0.018), 2.27).tree;
    expect(mountBore(findNode(out, 'mt')!) * 1000).toBeCloseTo(40.86, 6);
  });

  it('never snaps a MIN-DIAMETER mount, because that mount IS the airframe', () => {
    // A body tube with motorMount is the case-is-the-airframe build. Snapping
    // its outer radius resizes the rocket's skin and leaves it discontinuous
    // with the nose cone above it, which the kernel then warns about.
    const t: RocketTree = {
      name: 'md', components: [{
        type: 'stage', id: 's', children: [
          { type: 'nosecone', id: 'n', length: 0.2, aftRadius: 0.0145 } as ComponentNode,
          {
            type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.0145, thickness: 0.0008,
            motorMount: true,
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const res = scaleRocket(t, 1.5, { snapMounts: true });
    const tube = findNode(res.tree, 'b')!;
    const nose = findNode(res.tree, 'n')!;
    // Scaled, not snapped - and still continuous with the nose cone.
    expect(tube['outerRadius']).toBeCloseTo(0.0145 * 1.5, 12);
    expect(tube['outerRadius']).toBeCloseTo(nose['aftRadius'] as number, 12);
    expect(res.notes.join(' ')).toContain('it was NOT snapped');
    expect(res.needsAttention).toBe(true);
  });

  it('does NOT cry "no longer fits" when snapping is what restores the fit', () => {
    // The check has to describe the bore the user will really get. A 27.4 mm
    // mount at 1.9x lands on 52.1 mm, which a 54 will not enter - but snapped
    // it becomes exactly 54 and the motor fits again. Warning anyway is how a
    // warning gets trained out of people.
    const t = withMount(0.0274);
    const unsnapped = previewMounts(t, 1.9, { assignedMotorDiameters: { mt: 0.054 }, snapMounts: false });
    const snapped = previewMounts(t, 1.9, { assignedMotorDiameters: { mt: 0.054 }, snapMounts: true });
    expect(unsnapped[0]!.motorStillFits).toBe(false);
    expect(snapped[0]!.motorStillFits).toBe(true);
    expect(snapped[0]!.finalBoreMm).toBeCloseTo(54, 9);
    // …and the note follows the same setting.
    expect(scaleRocket(t, 1.9, { snapMounts: true, assignedMotorDiameters: { mt: 0.054 } })
      .notes.join(' ')).not.toContain('no longer fits');
    expect(scaleRocket(t, 1.9, { assignedMotorDiameters: { mt: 0.054 } })
      .notes.join(' ')).toContain('no longer fits');
  });

  it('previews the bore the SCALED TREE really has, blank wall included', () => {
    // scaleNode multiplies a thickness only when it is PRESENT, so an absent
    // wall stays absent and the kernel keeps applying its own 0.5 mm default
    // to the bigger tube. Multiplying the whole bore by k assumed the default
    // scaled too, and the preview then disagreed with the applied tree by
    // 2 x 0.0005 x (k-1) - the same reader/writer split the snap path closed.
    const blank: RocketTree = {
      name: 'blank', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [{
            type: 'innertube', id: 'mt', length: 0.2, outerRadius: 0.0145,
            motorMount: true, position: { method: 'bottom', offset: 0 },
          } as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    };
    const preview = previewMounts(blank, 2)[0]!;
    const applied = findNode(scaleRocket(blank, 2).tree, 'mt')!;
    expect(applied['thickness']).toBeUndefined();       // still automatic
    expect(preview.scaledBoreMm).toBeCloseTo(mountBore(applied) * 1000, 9);
    // 0.029 outer, kernel's 0.5 mm wall -> 57.0 mm, NOT 28.0 x 2 = 56.0.
    expect(preview.scaledBoreMm).toBeCloseTo(57, 9);
  });

  it('a min-diameter mount is never counted as snappable, motor and all', () => {
    // The !isAirframe term in finalBoreMm had no test: the min-diameter case
    // passed no motor, so motorStillFits was unconditionally true and the
    // guard never ran. With a motor loaded the mutation is visible - snapping
    // would report a fit for a bore the transform then refuses to change.
    const md: RocketTree = {
      name: 'md', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.0145, thickness: 0.0008,
          motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    };
    // Bore 27.4 x 1.9 = 52.1 mm; a 54 will not enter it, and snapping is
    // refused because this tube IS the airframe.
    const p = previewMounts(md, 1.9, { assignedMotorDiameters: { b: 0.054 }, snapMounts: true })[0]!;
    expect(p.isAirframe).toBe(true);
    expect(p.snappable).toBe(false);
    expect(p.finalBoreMm).toBeCloseTo(p.scaledBoreMm, 9);
    expect(p.motorStillFits).toBe(false);
  });

  it('names the FINAL bore when a motor stops fitting, not the pre-snap one', () => {
    // 27.4 mm bore at 1.9x is 52.1 mm and a 54 will not enter it; snapped, the
    // bore is exactly 54 and it does. Whichever way the user leaves the tick
    // box, the note has to name the bore they are getting.
    const t = withMount(0.0274);
    const unsnapped = scaleRocket(t, 1.9, { assignedMotorDiameters: { mt: 0.054 } });
    expect(unsnapped.notes.join(' ')).toContain('no longer fits the 52.1 mm bore');
    const snapped = scaleRocket(t, 1.9, {
      snapMounts: true, assignedMotorDiameters: { mt: 0.054 },
    });
    expect(snapped.notes.join(' ')).not.toContain('no longer fits');

    // And the case where the two bores DIFFER and the motor fits neither:
    // 27.4 mm halved is 13.7 mm, snapped to the standard 13. The note must
    // name 13.0 — the bore the user gets — not the 13.7 it passed through.
    const shrunk = scaleRocket(t, 0.5, {
      snapMounts: true, assignedMotorDiameters: { mt: 0.029 },
    }).notes.join(' ');
    expect(shrunk).toContain('no longer fits the 13.0 mm bore');
    expect(shrunk).not.toContain('13.7 mm bore');
  });

  it('counts a protuberance’s typed weight in the re-weigh note too', () => {
    // Same gap as the mass component one, one type over: scaleNode cubes a
    // protuberance's `mass` exactly the same way, so naming only
    // 'masscomponent' in the count left it silent.
    const t: RocketTree = {
      name: 'bump', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [{
            type: 'protuberance', id: 'pr', width: 0.02, height: 0.01, mass: 0.04,
            position: { method: 'top', offset: 0.1 },
          } as unknown as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    };
    expect(scaleRocket(t, 2).notes.join(' ')).toContain('1 pinned mass');
    expect(findNode(scaleRocket(t, 2).tree, 'pr')!['mass']).toBeCloseTo(0.32, 12);
  });

  it('a protuberance at its DEFAULT mass of 0 is not a pinned mass', () => {
    // The sibling of the test above, and the case it created: a protuberance is
    // born with `mass: 0` (schema.ts), the .ork reader always writes the key,
    // and the field's own label reads "0 = not counted". Counting `!== null`
    // made every design holding a stock protuberance tell the user to go and
    // re-weigh a part that weighs nothing.
    const bump = (mass: number): RocketTree => ({
      name: 'bump', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [{
            type: 'protuberance', id: 'pr', width: 0.02, height: 0.01, mass,
            position: { method: 'top', offset: 0.1 },
          } as unknown as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    });
    expect(scaleRocket(bump(0), 2).notes.join(' ')).not.toContain('pinned mass');
    // Not a blanket "protuberances never count" — a typed weight still does.
    expect(scaleRocket(bump(0.04), 2).notes.join(' ')).toContain('1 pinned mass');
    // Same for a deliberate overrideMass of 0: 0 · k³ is 0, so there is
    // nothing for the reader to go and check.
    const zeroOverride: RocketTree = {
      name: 'z', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, overrideMass: 0,
        } as ComponentNode],
      } as ComponentNode],
    };
    expect(scaleRocket(zeroOverride, 2).notes.join(' ')).not.toContain('pinned mass');
  });

  it('flags an assigned motor that no longer fits', () => {
    const t = withMount(0.038);
    const shrunk = previewMounts(t, 0.5, { assignedMotorDiameters: { mt: 0.038 } });
    expect(shrunk[0]!.motorStillFits).toBe(false);
    const grown = previewMounts(t, 2, { assignedMotorDiameters: { mt: 0.038 } });
    expect(grown[0]!.motorStillFits).toBe(true);
  });

  it('the SNAP can lose a motor the scaled bore kept, and says so', () => {
    // The branch that was left out on the reasoning that snapping goes to the
    // NEAREST class, so anything the scaled bore accepted the snapped bore
    // accepts too. False: `nearestCommonClass` only ever answers with a COMMON
    // class, and the motor database really holds 10.5, 20, 32, 64, 81 and
    // 161 mm ones. The earlier attempt to build this case used a 45 mm motor,
    // which is not a class the database has — which is why it looked unreachable.
    //
    // 31.75 mm bore x2 = 63.5 mm, which takes a 64 mm motor (bores run 1 mm
    // oversize). Nearest COMMON class to 63.5 is 54, and 64 does not go in 54.
    const t = withMount(0.03175);
    const unsnapped = previewMounts(t, 2, { assignedMotorDiameters: { mt: 0.064 }, snapMounts: false })[0]!;
    expect(unsnapped.scaledBoreMm).toBeCloseTo(63.5, 9);
    expect(unsnapped.nearestMm).toBe(54);
    expect(unsnapped.motorStillFits).toBe(true);

    const snapped = previewMounts(t, 2, { assignedMotorDiameters: { mt: 0.064 }, snapMounts: true })[0]!;
    expect(snapped.motorStillFits).toBe(false);
    // The discriminant that separates "the scale lost it" from "the snap lost
    // it" — the second is undone by clearing a checkbox.
    expect(snapped.motorFitsUnsnapped).toBe(true);

    const notes = scaleRocket(t, 2, { snapMounts: true, assignedMotorDiameters: { mt: 0.064 } })
      .notes.join(' ');
    expect(notes).toContain('Snapping to the standard size is what lost it');
    expect(notes).toContain('63.5 mm bore still takes it');
  });

  it('does NOT blame the snap when the scale is what lost the motor', () => {
    // The other half: shrinking loses the motor whatever the checkbox says, and
    // telling the user to untick a box that will not help is worse than silence.
    const t = withMount(0.038);
    const p = previewMounts(t, 0.5, { assignedMotorDiameters: { mt: 0.038 }, snapMounts: true })[0]!;
    expect(p.motorStillFits).toBe(false);
    expect(p.motorFitsUnsnapped).toBe(false);
    const notes = scaleRocket(t, 0.5, { snapMounts: true, assignedMotorDiameters: { mt: 0.038 } })
      .notes.join(' ');
    expect(notes).toContain('no longer fits');
    expect(notes).not.toContain('what lost it');
  });

  it('one verdict drives the list, the notes and the notice', () => {
    // These three used to be re-derived independently and two had already
    // drifted: an off-class AIRFRAME mount with the snap OFF was told by the
    // dialog it was "left for you to resize" — an explanation of a snap that
    // was never going to happen — and by the notes that it simply was not a
    // standard size.
    // NOT factor 1 — scaleRocket short-circuits k === 1 to no notes at all, so
    // a fixture built on it cannot reach the branches this pins.
    // 20 mm bore x2 = 40 mm, nearest class 38: off-class after scaling.
    const airframe: RocketTree = {
      name: 'min', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.0105, thickness: 0.0005,
          motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    };
    expect(previewMounts(airframe, 2, { assignedMotorDiameters: {}, snapMounts: false })[0]!.scaledBoreMm).toBeCloseTo(40, 9);
    expect(previewMounts(airframe, 2, { assignedMotorDiameters: {}, snapMounts: false })[0]!.verdict).toBe('off-class');
    expect(previewMounts(airframe, 2, { assignedMotorDiameters: {}, snapMounts: true })[0]!.verdict).toBe('airframe-left');
    // Only the snap-on case may talk about being left for the user to resize.
    expect(scaleRocket(airframe, 2, { snapMounts: false }).notes.join(' '))
      .not.toContain('NOT snapped');
    expect(scaleRocket(airframe, 2, { snapMounts: true }).notes.join(' '))
      .toContain('NOT snapped');
    // needsAttention is the third consumer and must agree with both.
    expect(scaleRocket(airframe, 2, { snapMounts: false }).needsAttention).toBe(true);
    expect(scaleRocket(airframe, 2, { snapMounts: true }).needsAttention).toBe(true);
    // …and a mount that lands ON a class needs no attention under either
    // setting. 27 mm bore x2 = 54 mm exactly.
    const onClass = withMount(0.027);
    expect(previewMounts(onClass, 2, { assignedMotorDiameters: {}, snapMounts: false })[0]!.verdict).toBe('on-class');
    expect(scaleRocket(onClass, 2, { snapMounts: false }).needsAttention).toBe(false);
    expect(scaleRocket(onClass, 2, { snapMounts: true }).needsAttention).toBe(false);
  });

  it('says UP when the snap goes up, DOWN when it goes down', () => {
    // Both directions, because a hard-coded word and an INVERTED comparison
    // fail differently and only one fixture sees each. The app's own default
    // design is the up case (18 mm bore x2 = 36, snapped up to 38) and every
    // fixture the suite had before was a down case, which is how "snapped up
    // from" survived on a mount that shrank.
    const up = scaleRocket(withMount(0.018), 2, { snapMounts: true }).notes.join(' ');
    expect(up).toContain('snapped up to the standard 38 mm');

    // 27.4 x2 = 54.8, snapped down to 54.
    const down = scaleRocket(withMount(0.0274), 2, { snapMounts: true }).notes.join(' ');
    expect(down).toContain('snapped down to the standard 54 mm');
  });

  it('the owner’s LOC IV case: 75 is the arithmetic, 98 is what you build', () => {
    // His 2026-09-01a report, measured rather than taken on trust. A LOC IV is
    // a 4 in (101.6 mm) airframe on a 38 mm mount; LOC's BT 7.51 is 190.75 mm,
    // so the factor is 1.8775 and the mount scales to 71.34 mm, whose nearest
    // common class is 75. "which is the proper scale, but most people would
    // choose a 98mm motor mount in a rocket that large."
    const t = withMount(0.038);
    const k = (7.51 * 25.4) / (4.0 * 25.4);
    const arithmetic = previewMounts(t, k)[0]!;
    expect(arithmetic.scaledBoreMm).toBeCloseTo(71.345, 2);
    expect(arithmetic.nearestMm).toBe(75);

    // Choosing 98 overrides both the scaled size and the nearest.
    const chosen = previewMounts(t, k, { mountChoices: { mt: { boreMm: 98 } } })[0]!;
    expect(chosen.targetBoreMm).toBe(98);
    expect(chosen.finalBoreMm).toBe(98);
    expect(chosen.verdict).toBe('resized');

    const out = scaleRocket(t, k, { mountChoices: { mt: { boreMm: 98 } } });
    // The applied tube really has a 98 mm bore, wall preserved.
    expect(mountBore(findNode(out.tree, 'mt')!) * 1000).toBeCloseTo(98, 9);
    expect(out.notes.join(' ')).toContain('resized to the standard 98 mm mount you chose');
    // A size he asked for is not a complaint.
    expect(out.needsAttention).toBe(false);
  });

  it('a per-mount choice overrides the global snap toggle, both ways', () => {
    const t = withMount(0.0274); // 54.8 mm at 2x -> snaps down to 54
    // Toggle on, no choice: snapped.
    expect(previewMounts(t, 2, { snapMounts: true })[0]!.verdict).toBe('snapped');
    // Toggle on, but this mount asked to be left alone.
    const left = previewMounts(t, 2, { snapMounts: true, mountChoices: { mt: 'scaled' } })[0]!;
    expect(left.targetBoreMm).toBeNull();
    expect(left.finalBoreMm).toBeCloseTo(54.8, 9);
    // Toggle OFF, but this mount asked for the nearest.
    const snapped = previewMounts(t, 2, { snapMounts: false, mountChoices: { mt: 'nearest' } })[0]!;
    expect(snapped.targetBoreMm).toBe(54);
    expect(snapped.verdict).toBe('snapped');
  });

  it('a custom bore that is not a standard size is applied and named as itself', () => {
    // For the EX builders: "allow those users that fabricate their own EX motor
    // sizes to input a number."
    const t = withMount(0.038);
    const p = previewMounts(t, 2, { mountChoices: { mt: { boreMm: 64 } } })[0]!;
    expect(p.finalBoreMm).toBe(64);
    expect(p.verdict).toBe('resized');
    const out = scaleRocket(t, 2, { mountChoices: { mt: { boreMm: 64 } } });
    expect(mountBore(findNode(out.tree, 'mt')!) * 1000).toBeCloseTo(64, 9);
    // Named as a plain number, NOT dressed up as a standard class.
    expect(out.notes.join(' ')).toContain('resized to the 64.0 mm mount you chose');
    expect(out.notes.join(' ')).not.toContain('standard 64');
  });

  it('an on-class mount is still choosable, and a body-tube mount is not', () => {
    // The measured hole in gating on `snappable`: a mount already sitting on a
    // class has nothing for the TOGGLE to do, but "my scaled 75 should be a 98"
    // is exactly the owner's case, so the pulldown must still be offered.
    const onClass = previewMounts(withMount(0.027), 2)[0]!; // 27 -> 54 exactly
    expect(onClass.verdict).toBe('on-class');
    expect(onClass.snappable).toBe(false);
    expect(onClass.choosable).toBe(true);

    // A mount that IS the airframe is never resized, whatever is asked.
    const airframe: RocketTree = {
      name: 'min', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.0105, thickness: 0.0005,
          motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    };
    const af = previewMounts(airframe, 2, { mountChoices: { b: { boreMm: 98 } } })[0]!;
    expect(af.choosable).toBe(false);
    expect(af.targetBoreMm).toBeNull();
    expect(mountBore(findNode(
      scaleRocket(airframe, 2, { mountChoices: { b: { boreMm: 98 } } }).tree, 'b')!) * 1000)
      .toBeCloseTo(40, 9); // the scaled bore, untouched
  });

  it('the notes name a class the way the dialog does — 75/76, not 75', () => {
    // classLabel exists because the 75 class covers both 75 and 76 mm casings.
    // The dialog used it and the notes interpolated the raw number, so the same
    // mount in the same sitting was "75/76 mm" in one place and "75 mm" in the
    // other — which reads to a 76 mm casing owner as though their size was not
    // the one being targeted.
    const t = withMount(0.038); // 38 mm bore x2 = 76 mm -> class 75
    const p = previewMounts(t, 2, { assignedMotorDiameters: {}, snapMounts: true })[0]!;
    expect(p.nearestMm).toBe(75);
    expect(scaleRocket(t, 2, { snapMounts: true }).notes.join(' ')).toContain('75/76 mm');
  });

  it('snapping a case-airframe mount writes the bore mountBore will read back', () => {
    // `outerRadiusForBore` is the inverse of `mountBore`, caseAirframe branch
    // included. Nothing in the UI makes a caseAirframe INNER tube today — which
    // is exactly why the writer's hard-coded `bore/2 + wall` looked safe — so
    // this builds one directly: a split held shut by call-site geometry is one
    // wrong assumption away from opening.
    const t: RocketTree = {
      name: 'case', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.04, children: [{
            type: 'innertube', id: 'mt', length: 0.2, outerRadius: 0.0175,
            thickness: 0.0008, motorMount: true, caseAirframe: true,
            position: { method: 'bottom', offset: 0 },
          } as unknown as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    };
    // caseAirframe: the bore IS the outer diameter. 17.5 mm radius -> 35 mm,
    // x2 = 70 mm, nearest common class 75.
    const p = previewMounts(t, 2, { assignedMotorDiameters: {}, snapMounts: true })[0]!;
    expect(p.scaledBoreMm).toBeCloseTo(70, 9);
    expect(p.nearestMm).toBe(75);
    expect(p.finalBoreMm).toBeCloseTo(75, 9);
    const applied = scaleRocket(t, 2, { snapMounts: true }).tree;
    // The promise the preview made, read back through the reader. With the old
    // writer this came out at 75 + 2x1.6 = 78.2 mm.
    expect(mountBore(findNode(applied, 'mt')!) * 1000).toBeCloseTo(75, 9);
  });
});

describe('scaleRocket — guardrails and reporting', () => {
  it('a pinned mass scales the way the SAME part’s computed mass does', () => {
    // Densities are untouched, so a COMPUTED canopy goes as k^2 and a computed
    // cord as k. A PINNED one has to match, or a design where the user typed a
    // weight behaves differently from one where they did not - and a preset
    // pins one automatically, since most catalogue chutes carry a mass that
    // presetPatch writes as overrideMass. Under a flat cube a catalogued 85 g
    // chute came out at 680 g, while the summary printed beside it said
    // recovery gear does not go as the cube.
    const t: RocketTree = {
      name: 'pinned', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [
            { type: 'parachute', id: 'pc', diameter: 0.6, overrideMass: 0.08505,
              position: { method: 'top', offset: 0.1 } } as ComponentNode,
            { type: 'streamer', id: 'sm', stripLength: 0.8, stripWidth: 0.08, overrideMass: 0.01,
              position: { method: 'top', offset: 0.2 } } as ComponentNode,
            { type: 'shockcord', id: 'sc', cordLength: 2, overrideMass: 0.02,
              position: { method: 'top', offset: 0.3 } } as ComponentNode,
            { type: 'masscomponent', id: 'mc', mass: 0.025, length: 0.05, radius: 0.02,
              position: { method: 'top', offset: 0.4 } } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    const out = scaleRocket(t, 2).tree;
    expect(findNode(out, 'pc')!['overrideMass']).toBeCloseTo(0.08505 * 4, 12);  // area
    expect(findNode(out, 'sm')!['overrideMass']).toBeCloseTo(0.01 * 4, 12);     // area
    expect(findNode(out, 'sc')!['overrideMass']).toBeCloseTo(0.02 * 2, 12);     // length
    expect(findNode(out, 'mc')!['mass']).toBeCloseTo(0.025 * 8, 12);            // volume
  });

  it('a fixed-size part keeps its CG override too, not just its dimensions', () => {
    // A rail button that is still 9.7 mm across must keep a CG station measured
    // within it. Scaling the override alone points it outside the part.
    const t: RocketTree = {
      name: 'cg', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [
            { type: 'railbutton', id: 'rb', outerDiameter: 0.0102, overrideCGX: 0.004,
              position: { method: 'top', offset: 0.2 } } as ComponentNode,
            { type: 'fairing', id: 'fa', length: 0.1, width: 0.04, height: 0.03,
              overrideCGX: 0.05, position: { method: 'top', offset: 0.3 } } as ComponentNode,
            { type: 'masscomponent', id: 'mc', mass: 0.02, length: 0.05, overrideCGX: 0.02,
              position: { method: 'top', offset: 0.4 } } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    const out = scaleRocket(t, 3).tree;
    expect(findNode(out, 'rb')!['overrideCGX']).toBe(0.004);            // unscaled part
    expect(findNode(out, 'fa')!['overrideCGX']).toBe(0.05);             // unscaled part
    expect(findNode(out, 'mc')!['overrideCGX']).toBeCloseTo(0.06, 12);  // scaled part
  });

  it('a factor of 1, 0 or NaN is a no-op that returns the same tree', () => {
    const t = kitchenSink();
    for (const f of [1, 0, -2, NaN, Infinity]) {
      const r = scaleRocket(t, f);
      expect(r.tree).toBe(t);
      expect(r.notes).toEqual([]);
    }
  });

  it('does not mutate the tree it was given', () => {
    const t = kitchenSink();
    const snapshot = JSON.stringify(t);
    scaleRocket(t, K);
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it('counts a mass component in the re-weigh note, not just an overrideMass', () => {
    // A mass component's `mass` IS its pinned weight - there is no geometry to
    // compute one from - so a design whose ballast is all mass components used
    // to get no "re-weigh it" note at all.
    const t: RocketTree = {
      name: 'ballast', components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: [
            { type: 'masscomponent', id: 'mc', mass: 0.025, length: 0.05, radius: 0.02,
              position: { method: 'top', offset: 0.1 } } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    const notes = scaleRocket(t, 2).notes.join(' ');
    expect(notes).toContain('1 pinned mass');
    expect(notes).toContain('re-weigh it');
    expect(findNode(scaleRocket(t, 2).tree, 'mc')!['mass']).toBeCloseTo(0.2, 12);
  });

  it('measures the rocket for the headline', () => {
    const t = kitchenSink();
    expect(maxBodyDiameter(t)).toBeCloseTo(0.1, 12);
    // The CORE chain only: nose + transition + body tube. The pod's 0.2 m tube
    // and the booster's 0.25 m tube hang off the side and are not length.
    expect(rocketLength(t)).toBeCloseTo(0.3 + 0.1 + 0.9, 12);
    const notes = scaleRocket(t, 2).notes;
    expect(notes[0]).toContain('200.0 %');
    expect(notes.join(' ')).toContain('camera shrouds and rail buttons');
    expect(notes.join(' ')).toContain('Reynolds');
  });
});
