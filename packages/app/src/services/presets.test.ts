import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { applyPresetLinks, csvToPresets, KIND_FOR_TYPE, presetPatch, presetsToCsv, type Preset } from './presets.js';
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

  it('the four cliffs the published weights created are gone', () => {
    // NOT "monotonic in size" — that would be false and the earlier name for
    // this test said it anyway. Seven of the 25 adjacent pairs still step
    // down, every one where a thinner-walled larger tube follows a thicker
    // smaller one (29 mm -> 38 mm Thin, 4" Thick -> 4.5", 8.25" -> 9"). That
    // is real: a thinner tube weighs less.
    //
    // What the anchor DID fix is the four cliffs at the four published sizes,
    // and that is what this pins — the 8" no longer coming out lighter than
    // the smaller 7.5" on an identical 0.095" wall.
    const perFoot = (p: (typeof cw)[number]) => {
      const ri = (p['insideDiameter'] as number) / 2;
      const ro = (p['outsideDiameter'] as number) / 2;
      return p.material!.density * Math.PI * (ro * ro - ri * ri) * 0.3048;
    };
    const bySize = [...cw].sort(
      (a, b) => (a['outsideDiameter'] as number) - (b['outsideDiameter'] as number));
    const at = (n: string) => perFoot(cw.find((p) => p.partNo === n)!);
    expect(at('8 Inch Airframe')).toBeGreaterThan(at('7.5 Inch Airframe'));
    expect(at('9 Inch Airframe')).toBeGreaterThan(at('8 Inch Airframe'));
    expect(at('11.67 Inch Airframe')).toBeGreaterThan(at('9 Inch Airframe'));
    expect(perFoot(bySize.at(-1)!)).toBeGreaterThan(perFoot(bySize[0]!));
  });

  it('the four published weights are reported, not used as mass', () => {
    const claimed = cw.filter((p) => /Composite Warehouse states/.test(p.description));
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

describe('presetPatch — transition `filled` (ruled 2026-09-03: "Fix it.")', () => {
  const solidNoMass = db.filter((x) => x.kind === 'Transition' && x['filled'] === true && x.mass === undefined);

  it('applies filled:true on a transition exactly as the nose-cone branch always did', () => {
    const p = solidNoMass[0]!;
    const patch = presetPatch('transition', p);
    expect(patch['filled']).toBe(true);
    // No catalogue mass, so the kernel computes it — which is the whole point of the flag.
    expect(patch['overrideMass']).toBeUndefined();
  });

  it('the population the fix moves is hundreds of balsa reducers (314 measured 2026-09-03)', () => {
    // Not pinned exactly — the catalogue regenerates — but a collapse here would
    // mean the `filled` column stopped arriving from the .orc source.
    expect(solidNoMass.length).toBeGreaterThan(250);
  });

  it('a solid balsa reducer weighs like solid balsa in the kernel, not like a 2 mm shell', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    // A real-sized part: BalsaMachining's BT-20 V2 tail cone, 41 mm long, 18.7 → 12.3 mm.
    // (A 6 mm nozzle cone is nearly all wall at 2 mm, so its solid/hollow ratio is
    // only 1.5x — measured 2026-09-03 — and would not make the point.)
    const p = solidNoMass.find((x) => x.manufacturer === 'BalsaMachining' && x.partNo === 'BMS20V2B')!;
    expect(p).toBeTruthy();
    const patch = presetPatch('transition', p) as Record<string, unknown>;
    const massOf = (children: unknown[]) => {
      const tree = { name: 't', components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'b', length: 0.1, outerRadius: 0.012, thickness: 0.0005, density: 680 },
        ...children,
      ] }] } as unknown as Parameters<typeof engineTree>[0];
      return OrkRocket.buildTree(engineTree(tree)).staticInfo().mass;
    };
    const base = massOf([]);
    const hollow: Record<string, unknown> = { ...patch };
    delete hollow['filled'];
    const solid = massOf([{ type: 'transition', id: 'x', ...patch }]) - base;
    const shell = massOf([{ type: 'transition', id: 'x', ...hollow }]) - base;
    // Measured 2026-09-03: solid 1.013 g, hollow 0.426 g (2.4x). The solid figure
    // sits within a conical-frustum estimate of the ogive body (0.887 g) plus its
    // shoulder — so `filled` is reaching the kernel and doing what it says.
    expect(shell).toBeGreaterThan(0);
    expect(solid).toBeGreaterThan(shell * 2);
    const r1 = (p['foreOutsideDiameter'] as number) / 2, r2 = (p['aftOutsideDiameter'] as number) / 2;
    const frustum = Math.PI / 3 * (p['length'] as number) * (r1 * r1 + r1 * r2 + r2 * r2) * p.material!.density;
    expect(solid).toBeGreaterThan(frustum * 0.9);
    expect(solid).toBeLessThan(frustum * 1.5);
  }, 60000);
});

describe('presetPatch — a canopy Cd travels with its spill hole (2026-09-03)', () => {
  it('applies both, because the Cd is referenced to the vented area', () => {
    const p = db.find((x) => x.kind === 'Parachute' && x.partNo === 'IFC-084-S')!;
    expect(p, 'IFC-084-S has gone from the database').toBeTruthy();
    const patch = presetPatch('parachute', p);
    expect(patch['cd']).toBe(2.2);
    expect(patch['spillHoleDiameter']).toBeCloseTo(84 * 0.176 * 0.0254, 6);
  });

  it('every Fruity Chutes row patches both or neither — never a bare Cd', () => {
    for (const p of db.filter((x) => x.kind === 'Parachute' && /fruity/i.test(x.manufacturer))) {
      const patch = presetPatch('parachute', p) as Record<string, unknown>;
      expect(typeof patch['cd'], String(p.partNo)).toBe('number');
      expect(typeof patch['spillHoleDiameter'], `${p.partNo} got a Cd with no spill hole`).toBe('number');
    }
  });
});

describe('presetPatch — the catalogue identity rides with the part (2026-09-03)', () => {
  it('names its manufacturer and part number so a saved file can find the row again', () => {
    const p = db.find((x) => x.kind === 'Parachute')!;
    const patch = presetPatch('parachute', p);
    expect(patch['presetManufacturer']).toBe(p.manufacturer);
    expect(patch['presetPartNo']).toBe(p.partNo);
  });
});

describe("applyPresetLinks — a file's part matched to its catalogue row (ruled 2026-09-03)", () => {
  // The owner's own Wildman .rkt: <PartMfg>Fruity Chutes</PartMfg><PartNo>29185</PartNo>
  // on a chute whose <DragCoefficient> is RockSim's 0.75 "auto" sentinel.
  const mk = (over: Record<string, unknown> = {}): ComponentNode =>
    ({ type: 'parachute', id: 'p1', name: 'Main', diameter: 2.4384, lineCount: 6, ...over }) as ComponentNode;

  it("fills what the file left unset and leaves the file's explicit values alone", () => {
    const node = mk();
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, notes)).toBe(1);
    expect(node['cd']).toBe(2.2);                 // unset in the file → the catalogue's
    expect(node['spillHoleDiameter']).toBeGreaterThan(0); // and its spill hole, inseparably
    expect(node['lineCount']).toBe(6);            // the file said 6; the catalogue's does NOT win
    expect(node['diameter']).toBe(2.4384);        // ditto
    expect(node.name).toBe('Main');               // the file's name, not the catalogue's
    expect(node['overrideMass']).toBeUndefined(); // the catalogue never supplies the mass
    expect(node['presetManufacturer']).toBe('Fruity Chutes');
    // 29185 was DROPPED on 2026-09-03 as a duplicate; the link resolves through
    // the surviving row's altPartNos, and stamps THAT row's part number.
    expect(node['presetPartNo']).toBe('IFC-096-N');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/matched the parts catalogue/);
    expect(notes[0]).toMatch(/drag coefficient/);
  });

  it('a dropped duplicate part number still finds its canopy — files outlive catalogue rows', () => {
    // Eric's own 4in WM Extreme.rkt carries <PartNo>29185</PartNo>. Dropping that
    // row must not cost his file its Cd.
    for (const [rockSim, sku] of [['29161', 'CFC-015-N'], ['29184', 'IFC-084-N'], ['29185', 'IFC-096-N']] as const) {
      const node = mk();
      expect(applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: rockSim }], db, []), rockSim).toBe(1);
      expect(node['presetPartNo'], rockSim).toBe(sku);
      expect(typeof node['cd'], rockSim).toBe('number');
      expect(typeof node['spillHoleDiameter'], rockSim).toBe('number');
    }
  });

  it('matches through the alias table and part-number normalisation', () => {
    const node = mk();
    expect(applyPresetLinks([{ node, manufacturer: 'FRUITY-CHUTES', partNo: ' 29185 ' }], db, [])).toBe(1);
    expect(node['cd']).toBe(2.2);
  });

  it('an unknown part is left exactly as the file had it', () => {
    const node = mk();
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, manufacturer: 'Nobody', partNo: 'X-1' }], db, notes)).toBe(0);
    expect(node['cd']).toBeUndefined();
    expect(node['presetPartNo']).toBeUndefined();
    expect(notes).toHaveLength(0);
  });

  it('does nothing at all without a catalogue', () => {
    const node = mk();
    expect(applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], undefined, [])).toBe(0);
    expect(node['cd']).toBeUndefined();
  });

  it('a kind with no catalogue (a fin set) is skipped, not mis-matched', () => {
    const node = { type: 'trapezoidfinset', id: 'f', name: 'Fins' } as ComponentNode;
    expect(applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, [])).toBe(0);
  });
});
