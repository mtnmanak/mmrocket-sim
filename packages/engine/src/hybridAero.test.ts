import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrkRocket, type AeroDiagnostics, type AeroForceSample, type RocketTree } from './orkEngine.js';

const arcas = JSON.parse(readFileSync(new URL('../../../validation/fixtures/arcas-short.json', import.meta.url), 'utf8')) as RocketTree;
const machs = [0.3, 0.6, 0.79, 0.8, 0.85, 0.95, 1, 1.1, 1.2, 1.21, 2, 4];

function rocket(model: 'kbf' | 'supersonic' | 'hybrid', tree = arcas) {
  const r = OrkRocket.buildTree(tree);
  r.setRogersModifiedBarrowman(true);
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

// Nonzero AoA and angular rates exercise the final damped moments, not just CD/CP.
const sample = (r: OrkRocket, ms = machs): AeroForceSample[] => r.forceSamples(ms, 0.04, 0.7, 0.4, 0.9);

function blendCP(a: AeroDiagnostics['cp'], b: AeroDiagnostics['cp'], w: number): AeroDiagnostics['cp'] {
  const cna = (1 - w) * a[3] + w * b[3];
  return [0, 1, 2].map((i) => ((1 - w) * a[i]! * a[3] + w * b[i]! * b[3]) / cna)
    .concat(cna) as AeroDiagnostics['cp'];
}

function asymmetricTree(): RocketTree {
  const tree = structuredClone(arcas);
  const fin = tree.components[1]!.children![0]!;
  delete fin['airfoilSection'];
  fin.type = 'freeformfinset';
  fin['crossSection'] = 'rounded';
  fin['finCount'] = 2;
  fin['rotation'] = 0.4;
  fin['points'] = [[0, 0], [0.035, 0.055], [0.075, 0.055], [0.12, 0]];
  tree.components[1]!.children!.push({ ...structuredClone(fin), rotation: 0.4 + Math.PI / 2,
    points: [[0, 0], [0.02, 0.025], [0.045, 0.025], [0.08, 0]],
    position: { method: 'bottom', offset: -0.25 },
  });
  return tree;
}

describe('experimental memoryless Hybrid aerodynamics', () => {
  for (const section of ['named', 'airfoil', 'rounded', 'freeform', 'body-ratio'] as const) {
    it(`returns every endpoint force field exactly and blends first moments: ${section}`, () => {
      const tree = structuredClone(arcas);
      const fin = tree.components[1]!.children![0]!;
      if (section !== 'named') delete fin['airfoilSection'];
      fin['crossSection'] = section === 'rounded' ? 'rounded' : 'airfoil';
      if (section === 'freeform') {
        fin.type = 'freeformfinset';
        fin['points'] = [[0, 0], [0.035, 0.055], [0.075, 0.055], [0.12, 0]];
      }
      if (section === 'body-ratio') {
        tree.components[1]!.children!.push({ type: 'railbutton', name: 'Bump',
          outerDiameter: 0.014, overrideMass: 0, overrideCD: 0.01,
          overrideCDBodyRatio: 0.08, overrideCDBodyIncludesBase: true,
          position: { method: 'middle', offset: 0 },
        });
      }
      const k = sample(rocket('kbf', tree));
      const s = sample(rocket('supersonic', tree));
      const h = sample(rocket('hybrid', tree));
      for (let i = 0; i < machs.length; i++) {
        const m = machs[i]!;
        const actual = h[i]!;
        expect(actual.every(Number.isFinite)).toBe(true);
        if (m <= 0.8 || m >= 1.2) {
          expect(actual).toEqual((m <= 0.8 ? k : s)[i]);
          continue;
        }
        const t = (m - 0.8) / 0.4;
        const w = t * t * (3 - 2 * t);
        const a = k[i]!;
        const b = s[i]!;
        const cna = (1 - w) * a[3] + w * b[3];
        for (let f = 0; f < actual.length; f++) {
          const expected = f < 3
            ? ((1 - w) * a[f]! * a[3] + w * b[f]! * b[3]) / cna
            : (1 - w) * a[f]! + w * b[f]!;
          // 1e-10 absolute covers only floating arithmetic order, not aero error.
          expect(actual[f], `M=${m}, field=${f}`).toBeCloseTo(expected, 10);
        }
      }
    });
  }

  it('is continuous through the band and returns to Kbf on descending crossings', () => {
    const r = rocket('hybrid');
    const ms = Array.from({ length: 101 }, (_, i) => 0.75 + i * 0.005);
    const up = sample(r, ms);
    const down = sample(r, [...ms].reverse()).reverse();
    expect(down).toEqual(up);
    for (let i = 1; i < up.length; i++) {
      for (let f = 0; f < up[i]!.length; f++) {
        // At 0.005 Mach spacing: <= 10 mm CP and <= 0.25 in coefficient units
        // (CNa per radian). Fixture/rates above; not a universal aerodynamic limit.
        expect(Math.abs(up[i]![f]! - up[i - 1]![f]!), `M=${ms[i]}, field=${f}`)
          .toBeLessThan(f < 3 ? 0.01 : 0.25);
      }
    }
  });

  it('sets an experiment band, preserves exact endpoints, and rejects invalid bands atomically', () => {
    const r = rocket('hybrid');
    r.setHybridBand(0.4, 0.7);
    expect(sample(r, [0.3])).toEqual(sample(rocket('kbf'), [0.3]));
    expect(sample(r, [0.79])).toEqual(sample(rocket('supersonic'), [0.79]));
    for (const [low, high] of [[-1, 1], [1, 1], [2, 1], [NaN, 1], [0, Infinity]]) {
      expect(() => r.setHybridBand(low!, high!)).toThrow(/Hybrid band/);
    }
    expect(sample(r, [0.79])).toEqual(sample(rocket('supersonic'), [0.79]));
    r.setHybridBand(0.1, 0.2);
    expect(r.staticInfo()).toEqual(rocket('supersonic').staticInfo());
    r.setHybridAero(false);
    expect(sample(r)).toEqual(sample(rocket('kbf')));
  });

  it('keeps static preview and component sweep on the same blended law', () => {
    const h = rocket('hybrid');
    expect(h.staticInfo()).toEqual(rocket('kbf').staticInfo());
    for (const mach of [0.6, 0.95, 1.1, 2]) {
      const sweep = h.dragSweep({ machMin: mach, machMax: mach, machStep: 0.1, aoaDeg: 0 });
      const f = h.forceSamples([mach])[0]!;
      expect(sweep.cp[0]).toBe(f[0]);
      expect(sweep.cna[0]).toBe(f[3]);
      expect(sweep.powerOff.total[0]).toBe(f[11]);
      const total = sweep.components.reduce((sum, c) => sum + c.cd[0]!, 0);
      expect(total).toBeCloseTo(f[11], 12);
    }
  });

  it('blends getCP inside a custom band containing static-preview Mach 0.3', () => {
    const h = rocket('hybrid');
    h.setHybridBand(0.1, 0.5);
    const a = rocket('kbf').aeroDiagnostics(0.3).cp;
    const b = rocket('supersonic').aeroDiagnostics(0.3).cp;
    const expected = blendCP(a, b, 0.5);
    expect(Math.abs(expected[0] - a[0])).toBeGreaterThan(1e-5);
    h.aeroDiagnostics(0.3).cp.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 10));
    expect(h.staticInfo().cp).toBeCloseTo(expected[0], 10);
  });

  it('searches blended getCP for asymmetric worst CP inside the band', () => {
    const tree = asymmetricTree();
    const h = rocket('hybrid', tree);
    h.setHybridBand(0.1, 0.5);
    const a = rocket('kbf', tree).aeroDiagnostics(0.3);
    const b = rocket('supersonic', tree).aeroDiagnostics(0.3);
    // Blend each plane FIRST, then minimize; do not blend endpoint minima.
    const planes = a.cpByTheta.map((cp, i) => blendCP(cp, b.cpByTheta[i]!, 0.5));
    const expected = planes.filter((cp) => cp[3] > 1e-8).reduce((x, y) => x[0] < y[0] ? x : y);
    expect(Math.max(...planes.map((cp) => cp[0])) - expected[0]).toBeGreaterThan(0.01);
    expect(Math.abs(expected[0] - a.worstCP[0])).toBeGreaterThan(1e-6);
    const actual = h.aeroDiagnostics(0.3);
    actual.worstCP.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 10));
    expect(h.staticInfo().cpWorst).toBeCloseTo(expected[0], 10);
  });

  it('newInstance preserves a custom band rather than resetting to defaults', () => {
    const h = rocket('hybrid', asymmetricTree());
    h.setHybridBand(0.1, 0.5);
    const original = h.aeroDiagnostics(0.3, 0.04);
    expect(Math.abs(original.cp[0] - rocket('kbf', asymmetricTree()).aeroDiagnostics(0.3, 0.04).cp[0]))
      .toBeGreaterThan(1e-5);
    expect(h.aeroDiagnostics(0.3, 0.04, true)).toEqual(original);
  });

  it('reports stall margin after force evaluation below, inside and above the band', () => {
    const h = rocket('hybrid');
    h.setHybridBand(0.1, 0.5);
    for (const mach of [0.05, 0.3, 0.6]) {
      for (const aoa of [0.04, 0.4]) {
        const a = rocket('kbf').aeroDiagnostics(mach, aoa).stallMargin;
        const b = rocket('supersonic').aeroDiagnostics(mach, aoa).stallMargin;
        const w = mach <= 0.1 ? 0 : mach >= 0.5 ? 1 : 0.5;
        const actual = h.aeroDiagnostics(mach, aoa).stallMargin;
        expect(actual).toBeCloseTo((1 - w) * a + w * b, 12);
        // Both endpoint laws use 17.5 degrees minus AoA, returned in radians.
        expect(actual).toBeCloseTo(17.5 * Math.PI / 180 - aoa, 12);
        expect(Math.sign(actual)).toBe(aoa < 0.3 ? 1 : -1);
      }
    }
  });

  it('reports an explicit zero CP for zero normal-force weight', () => {
    const r = rocket('hybrid', { name: 'Bare cylinder', components: [
      { type: 'bodytube', length: 0.5, outerRadius: 0.02, thickness: 0.001 },
    ] });
    const f = r.forceSamples([0.95, 1, 1.1]);
    for (const row of f) {
      expect(row.slice(0, 4)).toEqual([0, 0, 0, 0]);
      expect(row.every(Number.isFinite)).toBe(true);
    }
  });
});
