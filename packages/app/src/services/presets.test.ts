import { describe, expect, it } from 'vitest';
import { csvToPresets, KIND_FOR_TYPE, presetPatch, presetsToCsv, type Preset } from './presets.js';
import presetsJson from '../data/presets.json';

const db = (presetsJson as { presets: Preset[] }).presets;

describe('bundled preset database', () => {
  it('is present and substantial', () => {
    expect(db.length).toBeGreaterThan(3000);
  });

  it('covers the main component kinds', () => {
    for (const kind of ['BodyTube', 'NoseCone', 'Transition', 'CenteringRing', 'Parachute']) {
      expect(db.some((p) => p.kind === kind), kind).toBe(true);
    }
  });
});

describe('presetPatch', () => {
  it('maps a real body tube preset to node params', () => {
    const p = db.find((x) => x.kind === 'BodyTube'
      && typeof x['outsideDiameter'] === 'number' && typeof x['insideDiameter'] === 'number')!;
    const patch = presetPatch('bodytube', p);
    expect(patch['outerRadius']).toBeCloseTo((p['outsideDiameter'] as number) / 2);
    expect(patch['thickness']).toBeCloseTo(
      ((p['outsideDiameter'] as number) - (p['insideDiameter'] as number)) / 2);
    if (p.material?.type === 'BULK') expect(patch['density']).toBe(p.material.density);
  });

  it('maps a nose cone with shoulder + shape + catalog mass', () => {
    const p = db.find((x) => x.kind === 'NoseCone'
      && typeof x['shoulderDiameter'] === 'number' && typeof x.mass === 'number')!;
    const patch = presetPatch('nosecone', p);
    expect(patch['shoulderRadius']).toBeCloseTo((p['shoulderDiameter'] as number) / 2);
    expect(typeof patch['shape']).toBe('string');
    expect(patch['overrideMass']).toBe(p.mass);
  });

  it('maps a parachute with surface and line materials', () => {
    const p = db.find((x) => x.kind === 'Parachute' && x.material?.type === 'SURFACE')!;
    const patch = presetPatch('parachute', p);
    expect(patch['diameter']).toBe(p['diameter']);
    expect(patch['surfaceDensity']).toBe(p.material!.density);
  });
});

describe('CSV round-trip', () => {
  it('export → import preserves the essentials', () => {
    const sample = db.filter((p) => p.kind === 'BodyTube').slice(0, 5);
    const back = csvToPresets(presetsToCsv(sample));
    expect(back).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(back[i]!.partNo).toBe(sample[i]!.partNo);
      expect(back[i]!.manufacturer).toBe(sample[i]!.manufacturer);
      expect(back[i]!['outsideDiameter']).toBeCloseTo(sample[i]!['outsideDiameter'] as number, 9);
      expect(back[i]!.material?.density).toBeCloseTo(sample[i]!.material!.density, 6);
    }
  });

  it('handles quoted descriptions with commas', () => {
    const p: Preset = {
      kind: 'BodyTube', manufacturer: 'Me', partNo: 'X1',
      description: 'Tube, big, "the best"', length: 0.3, outsideDiameter: 0.025,
    };
    const back = csvToPresets(presetsToCsv([p]));
    expect(back[0]!.description).toBe('Tube, big, "the best"');
  });

  it('handles NEWLINES inside quoted cells (the export writes them)', () => {
    const p: Preset = {
      kind: 'BodyTube', manufacturer: 'Me', partNo: 'X2',
      description: 'line one\nline two', length: 0.25, outsideDiameter: 0.02,
    };
    const q: Preset = { kind: 'BodyTube', manufacturer: 'Me', partNo: 'X3', description: 'plain' };
    const back = csvToPresets(presetsToCsv([p, q]));
    expect(back).toHaveLength(2);
    expect(back[0]!.description).toBe('line one\nline two');
    expect(back[0]!['length']).toBeCloseTo(0.25, 9);
    expect(back[1]!.partNo).toBe('X3');
  });

  it('round-trips parachute shroud-line material through the CSV', () => {
    const chute: Preset = {
      kind: 'parachute', manufacturer: 'Test', partNo: 'PC-1', description: 'Chute',
      material: { name: 'Ripstop nylon', type: 'SURFACE', density: 0.067 },
      lineMaterial: { name: 'Braided Kevlar', type: 'LINE', density: 0.0018 },
      diameter: 0.45, lineCount: 8, lineLength: 0.5,
    };
    const back = csvToPresets(presetsToCsv([chute]));
    expect(back).toHaveLength(1);
    expect(back[0]!.lineMaterial?.name).toBe('Braided Kevlar');
    expect(back[0]!.lineMaterial?.density).toBeCloseTo(0.0018, 9);
    expect(back[0]!.lineMaterial?.type).toBe('LINE');
  });
});

/**
 * v0.089 — the Composite Warehouse G12 tubes (owner request, 2026-08-31b) and
 * the inner-tube preset gate they exposed.
 */
describe('Composite Warehouse tubes', () => {
  const cw = db.filter((p) => p.manufacturer === 'Composite Warehouse');

  it('all 26 tubes are present, as BodyTube rows', () => {
    expect(cw).toHaveLength(26);
    expect(cw.every((p) => p.kind === 'BodyTube')).toBe(true);
  });

  /**
   * v0.090, Eric's ruling: EVERY row sits at handbook G12, including the four
   * the manufacturer publishes a weight for — all four of those weights imply
   * a density outside any real G12 laminate (2283/1209/1092/965 kg/m³ against
   * a handbook 1850–1940), and anchoring only the 22 unclaimed rows made the
   * catalogue non-monotonic: the 8" tube came out lighter per foot than the
   * smaller 7.5" on an identical 0.095" wall.
   *
   * This is the assertion the previous version of this suite did not have.
   * The old suite could not see a density change at all — it pinned the 4.5"
   * row's claimed weight (unmoved under the old policy) and otherwise only
   * asserted `density > 900`, which 2283, 1900 and 1092 all satisfy.
   */
  it('every row sits at the handbook G12 anchor, claimed or not', () => {
    expect(cw.map((p) => p.material!.density)).toEqual(Array(26).fill(1900));
  });

  it('mass per foot rises monotonically with tube size', () => {
    // The property the four claimed weights broke. Wall thickness varies, so
    // this is not trivially true from OD alone — it holds because one density
    // now spans the line.
    const perFoot = (p: (typeof cw)[number]) => {
      const ri = (p['insideDiameter'] as number) / 2;
      const ro = (p['outsideDiameter'] as number) / 2;
      return p.material!.density * Math.PI * (ro * ro - ri * ri) * 0.3048;
    };
    const bySize = [...cw].sort(
      (a, b) => (a['outsideDiameter'] as number) - (b['outsideDiameter'] as number));
    // Wall steps down at 4.15"->4.125" and 8.25"->9.005", so compare only the
    // 7.5/8/8.25/9/11.67 run the old policy inverted, plus the whole line's ends.
    const at = (n: string) => perFoot(cw.find((p) => p.partNo === n)!);
    expect(at('8 Inch Airframe')).toBeGreaterThan(at('7.5 Inch Airframe'));
    expect(at('9 Inch Airframe')).toBeGreaterThan(at('8 Inch Airframe'));
    expect(at('11.67 Inch Airframe')).toBeGreaterThan(at('9 Inch Airframe'));
    expect(perFoot(bySize.at(-1)!)).toBeGreaterThan(perFoot(bySize[0]!));
  });

  it('the four published weights are reported, not used as mass', () => {
    const claimed = cw.filter((p) => /the manufacturer states/.test(p.description));
    expect(claimed.map((p) => p.partNo).sort()).toEqual(
      ['11.67 Inch Airframe', '4.5 Inch Airframe', '8 Inch Airframe', '9 Inch Airframe']);
    // Each says the figure AND the impossible density it implies, so a reader
    // can see both numbers. 4.5": 13.8 oz/ft would need 2283 kg/m³.
    const t = cw.find((p) => p.partNo === '4.5 Inch Airframe')!;
    expect(t.description).toContain('13.8 oz/ft');
    expect(t.description).toContain('2283 kg/m3');
    // And the row does NOT weigh what the claim says: at 1900 it is lighter.
    const ri = (t['insideDiameter'] as number) / 2;
    const ro = (t['outsideDiameter'] as number) / 2;
    const ozPerFt = (t.material!.density * Math.PI * (ro * ro - ri * ri) * 0.3048) / 0.0283495;
    expect(ozPerFt).toBeCloseTo(11.48, 2);
  });

  it('carries neither length nor mass — the user keeps their cut', () => {
    // No length: CW cuts to order. No mass: a row mass would become an
    // overrideMass freezing one arbitrary length's weight onto the node.
    expect(cw.every((p) => p['length'] === undefined && p.mass === undefined)).toBe(true);
    const patch = presetPatch('bodytube', cw[0]!);
    expect(patch['length']).toBeUndefined();
    expect(patch['overrideMass']).toBeUndefined();
    expect(patch['density']).toBeGreaterThan(900);
  });

  it('an inner tube gets the BodyTube catalogue — desktop\'s own rule', () => {
    expect(KIND_FOR_TYPE['innertube']).toBe('BodyTube');
    // …and a 54 mm motor-mount tube patchs onto an innertube node cleanly.
    const t = cw.find((p) => p.partNo === '54mm Airframe')!;
    const patch = presetPatch('innertube', t);
    expect(patch['outerRadius']).toBeCloseTo((t['outsideDiameter'] as number) / 2, 12);
    expect(patch['thickness']).toBeCloseTo(
      ((t['outsideDiameter'] as number) - (t['insideDiameter'] as number)) / 2, 12);
  });

  it('the eleven motor-mount tubes say so in their descriptions', () => {
    const mmt = cw.filter((p) => p.description.includes('motor-mount tube'));
    expect(mmt).toHaveLength(11);
    // Spot the ones that matter to standard cases.
    for (const name of ['24mm Airframe', '29mm Airframe', '38mm Airframe', '54mm Airframe', '6 Inch MotorMount']) {
      expect(mmt.some((p) => p.partNo === name), name).toBe(true);
    }
  });
});
