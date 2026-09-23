import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { applyPresetLinks, csvToPresets, holdsCatalogueMass, KIND_FOR_TYPE, presetPatch, presetsToCsv, type Preset } from './presets.js';
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
  // csvUtil prefixes an apostrophe to any cell a spreadsheet would evaluate,
  // which is what stops an imported design's component name running as a
  // formula on someone else's machine. The READER has to take it back off, or
  // this app's own export stops round-tripping through this app's own import.
  it('survives a part number a spreadsheet would treat as a formula', () => {
    const hostile: Preset[] = [{
      kind: 'BodyTube',
      manufacturer: 'ACME',
      partNo: '=cmd|calc',
      description: '@SUM(A1)',
      outsideDiameter: 0.024,
    } as Preset];
    const csv = presetsToCsv(hostile);
    // The guard is really applied on the way out …
    expect(csv).toContain(`"'=cmd|calc"`);
    // … and is gone again on the way back in.
    const back = csvToPresets(csv);
    expect(back).toHaveLength(1);
    expect(back[0]!.partNo).toBe('=cmd|calc');
    expect(back[0]!.description).toBe('@SUM(A1)');
  });

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

describe('the launch report states the Cd each device FLEW (2026-09-03b)', () => {
  // Two landing-rate reports in one day came down to "which Cd did that run
  // use?", and neither the results page nor the report could answer it. It now
  // comes off the ENGINE tree — what the kernel was handed — so it stays true
  // even if the design and the flight ever disagree.
  it('reports the flown coefficient, and shows a vent doing its work', async () => {
    const { engineTree, flownRecoveryDevices } = await import('../tree/treeModel.js');
    const tree = { name: 'T', components: [{ type: 'stage', id: 's', children: [
      { type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.05, thickness: 0.001, density: 1800, children: [
        { type: 'parachute', id: 'm', name: 'Main', diameter: 2.1336, cd: 2.2 },
        { type: 'parachute', id: 'd', name: 'Drogue', diameter: 0.6096, cd: 1.5, spillHoleDiameter: 0.12192 },
      ] },
    ] }] } as unknown as Parameters<typeof engineTree>[0];
    const flown = flownRecoveryDevices(engineTree(tree));

    // Unvented: what the kernel got IS the design's number.
    // cdAutomatic false: this one was TYPED, so the column prints 2.20 with
    // no "(auto)" beside it (2026-09-21).
    expect(flown['Main']).toEqual({
      cd: 2.2, cdNominal: 2.2, cdAutomatic: false, diameter: 2.1336, spillHoleDiameter: null,
    });
    // Vented: the kernel takes the reduction in the coefficient (it has no vent
    // concept), and the pre-vent figure is kept so the report can show both.
    expect(flown['Drogue']!.cd).toBeCloseTo(1.44, 9);
    expect(flown['Drogue']!.cdNominal).toBe(1.5);
    expect(flown['Drogue']!.spillHoleDiameter).toBeCloseTo(0.12192, 9);
  });

  it('drops a duplicated device name rather than attributing one chute to the other', async () => {
    const { engineTree, flownRecoveryDevices } = await import('../tree/treeModel.js');
    const tree = { name: 'T', components: [{ type: 'stage', id: 's', children: [
      { type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.05, thickness: 0.001, density: 1800, children: [
        { type: 'parachute', id: 'a', name: 'Chute', diameter: 2.0, cd: 2.2 },
        { type: 'parachute', id: 'b2', name: 'Chute', diameter: 0.5, cd: 0.8 },
        { type: 'parachute', id: 'c', name: 'Other', diameter: 1.0, cd: 1.5 },
      ] },
    ] }] } as unknown as Parameters<typeof engineTree>[0];
    const flown = flownRecoveryDevices(engineTree(tree));
    // The kernel's events are keyed by name too, so a duplicate is genuinely
    // ambiguous — showing one device's number beside the other's descent rate
    // would be worse than showing none.
    expect(flown['Chute']).toBeUndefined();
    expect(flown['Other']!.cd).toBe(1.5);
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
    expect(notes[0]).toMatch(/matched the parts catalogue/);
    expect(notes[0]).toMatch(/drag coefficient/);
    // THE CONFLICT MARKER, tier (a) (approved 2026-09-07). The file said 6
    // lines; the IFC-096-N row says otherwise. The file's value STANDS — the
    // precedence ruling is unchanged — and a second sentence says so, once,
    // naming the part and the field. No stored state, nothing to dismiss.
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/1 of those parts states a value that disagrees with its catalogue row/);
    expect(notes[1]).toMatch(/the file's value was kept/);
    expect(notes[1]).toMatch(/Main: line count/);
    expect(node['lineCount']).toBe(6);
  });

  it('says nothing about a conflict when the file states nothing that disagrees', () => {
    // A file that states only what the catalogue agrees with, or nothing the
    // catalogue carries, gets the one match sentence and no second one — the
    // owner's condition was "warn without nagging".
    const node = mk({ lineCount: undefined });
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, notes)).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toMatch(/disagrees/);
  });

  it('compares a canopy’s Cd and spill hole only when the file states BOTH', () => {
    // Half a pair against a whole one is not a disagreement about the same
    // fact: a file stating a Cd alone (RockSim's usual case) gets no conflict
    // for the vent it never mentioned. Stating both, at values the catalogue
    // disagrees with, does.
    const half = mk({ lineCount: undefined, cd: 1.5 });
    const n1: string[] = [];
    applyPresetLinks([{ node: half, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, n1);
    expect(n1.some((n) => /disagrees/.test(n))).toBe(false);

    const both = mk({ lineCount: undefined, cd: 1.5, spillHoleDiameter: 0.01 });
    const n2: string[] = [];
    applyPresetLinks([{ node: both, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, n2);
    expect(n2.some((n) => /disagrees/.test(n) && /drag coefficient/.test(n))).toBe(true);
    expect(both['cd']).toBe(1.5); // kept
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

/**
 * A catalogue engine block gets its OWN diameter, not the airframe's bore.
 *
 * The `engineblock` branch read the row's `outsideDiameter` to compute the wall
 * and then threw the diameter away, so a catalogued thrust ring reached the
 * kernel with an AUTOMATIC outer radius — the parent tube's inner radius —
 * while every other tube-like kind (bodytube / tubecoupler / innertube /
 * launchlug) got `outerRadius` set. Desktop does set it:
 * ThicknessRingComponent.loadFromPreset:21-36 clears outerRadiusAutomatic and
 * writes OD/2 whenever the row has an OUTER_DIAMETER.
 *
 * It was invisible while the bridge applied the wall pre-attach, because the
 * clamp made the part weigh 0 g whatever radius it had. Now that the wall is
 * real, an Apogee CR 10-13 ring hung in a 29 mm mount would weigh the mount's
 * bore instead of its own 12.95 mm.
 */
describe('presetPatch — a catalogue engine block carries its own outer radius', () => {
  const rows = db.filter((x) => x.kind === 'EngineBlock'
    && typeof x['outsideDiameter'] === 'number' && typeof x['insideDiameter'] === 'number');

  it('is a populated catalogue, so the assertions below mean something', () => {
    expect(rows.length).toBeGreaterThan(20);
  });

  it('applies outerRadius = OD/2, exactly as the tube-coupler branch does', () => {
    const p = rows.find((x) => x.partNo === '13021') ?? rows[0]!;
    const patch = presetPatch('engineblock', p) as Record<string, unknown>;
    expect(patch['outerRadius']).toBeCloseTo((p['outsideDiameter'] as number) / 2, 12);
    // The wall it always applied stays exactly as it was.
    expect(patch['thickness']).toBeCloseTo(
      ((p['outsideDiameter'] as number) - (p['insideDiameter'] as number)) / 2, 12);
  });

  it('does it for every catalogued ring, not just the one spot-checked', () => {
    for (const p of rows) {
      const patch = presetPatch('engineblock', p) as Record<string, unknown>;
      expect(patch['outerRadius'], p.partNo).toBeCloseTo((p['outsideDiameter'] as number) / 2, 12);
    }
  });

  it('leaves a row with no outside diameter alone rather than writing zero', () => {
    const bare = { kind: 'EngineBlock', manufacturer: 'T', partNo: 'X', description: '',
      length: 0.005 } as unknown as Preset;
    const patch = presetPatch('engineblock', bare) as Record<string, unknown>;
    expect(patch['outerRadius']).toBeUndefined();
    expect(patch['length']).toBeCloseTo(0.005, 12);
  });
});

/**
 * The pair rule, at the IMPORT boundary (critic-2, 2026-09-04).
 *
 * `presetPatch` has written `cd` and `spillHoleDiameter` together since the
 * 2026-09-03 ruling, but `applyPresetLinks` then applied the patch key by key
 * under an independent `node[key] === undefined` gate — so a file that stated
 * one half of the pair took the catalogue's other half. Fruity Chutes CFC-015-N
 * is the worked case: a 15 in canopy whose maker's Cd 1.5 is measured against
 * their own 3 in (20 %) vent.
 */
describe('applyPresetLinks — the canopy Cd and its spill hole move together', () => {
  const CFC15 = { manufacturer: 'Fruity Chutes', partNo: 'CFC-015-N' };
  const row = db.find((p) => p.kind === 'Parachute' && p.partNo === CFC15.partNo)!;
  const chute = (over: Record<string, unknown> = {}): ComponentNode =>
    ({ type: 'parachute', id: 'p1', name: 'Main', diameter: 0.381, ...over }) as ComponentNode;

  it('the catalogue row this rests on is still a vented one', () => {
    expect(row, 'CFC-015-N has gone from the database').toBeTruthy();
    expect(row['dragCoefficient']).toBe(1.5);
    // 3 in vent on a 15 in canopy — the worst ratio in the catalogue, 0.20.
    expect((row['spillHoleDiameter'] as number) / (row['diameter'] as number)).toBeCloseTo(0.2, 6);
  });

  it('takes BOTH when the file states neither, and names both in the note', () => {
    const node = chute();
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, ...CFC15 }], db, notes)).toBe(1);
    expect(node['cd']).toBe(1.5);
    expect(node['spillHoleDiameter']).toBeCloseTo(0.0762, 9);
    expect(notes[0]).toMatch(/drag coefficient/);
    expect(notes[0]).toMatch(/spill hole/);
  });

  it('takes NEITHER when the file states its own vent — the 3.1 % CdA error', () => {
    // The author typed a 1.5 in vent on the 15 in canopy. Taking the maker's
    // Cd (measured against their 20 % vent) onto that 10 % vent applied a
    // factor of 0.99 where 0.96 was meant.
    const node = chute({ spillHoleDiameter: 0.0381 });
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, ...CFC15 }], db, notes)).toBe(1);
    expect(node['cd'], 'took a Cd referenced to a vent the file does not have').toBeUndefined();
    expect(node['spillHoleDiameter']).toBe(0.0381);   // the file's own, untouched
    expect(notes[0]).toMatch(/left the catalogue’s drag coefficient and spill hole out/);
    // The size of the error the refusal avoids, stated so it cannot be argued
    // away as rounding: 0.99 / 0.96 on Cd·A, and sqrt of that on descent rate.
    const bad = 1.5 * (1 - 0.1 ** 2);
    const good = 1.5 * (1 - 0.2 ** 2);
    expect(bad / good).toBeCloseTo(1.03125, 5);
    expect(Math.sqrt(good / bad)).toBeCloseTo(0.98473, 5);
  });

  it('takes NEITHER in reverse — the catalogue vent never lands on a file-stated Cd', () => {
    const node = chute({ cd: 0.97 });
    expect(applyPresetLinks([{ node, ...CFC15 }], db, [])).toBe(1);
    expect(node['cd']).toBe(0.97);
    expect(node['spillHoleDiameter'],
      'grafted the maker’s vent onto a Cd that was never measured against it').toBeUndefined();
  });

  it('an UNVENTED catalogue row is a whole fact and still supplies its Cd', () => {
    // 188 of the catalogue's parachutes publish a Cd and no vent; refusing
    // those would drop a real 0.97 back to the kernel's 0.8 for nothing.
    const unvented = db.find((p) => p.kind === 'Parachute'
      && typeof p['dragCoefficient'] === 'number' && (p['dragCoefficient'] as number) > 0
      && !(typeof p['spillHoleDiameter'] === 'number' && (p['spillHoleDiameter'] as number) > 0))!;
    expect(unvented).toBeTruthy();
    const node = chute();
    expect(applyPresetLinks([{
      node, manufacturer: unvented.manufacturer, partNo: unvented.partNo,
    }], db, [])).toBe(1);
    expect(node['cd']).toBe(unvented['dragCoefficient']);
    expect(node['spillHoleDiameter']).toBeUndefined();
  });

  it('the rest of the catalogue row still fills normally around the pair', () => {
    const node = chute({ spillHoleDiameter: 0.0381 });
    applyPresetLinks([{ node, ...CFC15 }], db, []);
    expect(node['lineCount']).toBe(8);
    expect(node['presetPartNo']).toBe('CFC-015-N');
  });
});

describe('csvToPresets — a blank cell is blank, whatever whitespace is in it', () => {
  it('does not turn a space into the number zero', () => {
    // `Number(' ') === 0` and `' ' !== ''`, so an untrimmed guard stored a
    // spreadsheet's leftover space as a real 0 — a zero mass, a zero diameter.
    const csv = 'kind,manufacturer,partNo,description,mass,length,outsideDiameter\n'
      + 'BodyTube,Custom,BT-X,test, ,  ,0.0254\n';
    const [p] = csvToPresets(csv);
    expect(p!.mass).toBeUndefined();
    expect(p!['length']).toBeUndefined();
    expect(p!['outsideDiameter']).toBe(0.0254);
  });

  it('still reads a padded number as that number', () => {
    const csv = 'kind,manufacturer,partNo,description,mass\nBodyTube,Custom,BT-X,test, 0.012 \n';
    expect(csvToPresets(csv)[0]!.mass).toBe(0.012);
  });

  it('a literal zero mass never becomes an overrideMass of zero', () => {
    // A component that contributes no mass at all, silently, while every other
    // field looks right is a CG and stability-margin error nobody can see.
    const p = { kind: 'NoseCone', manufacturer: 'Custom', partNo: 'X', description: '',
      mass: 0 } as Preset;
    expect((presetPatch('nosecone', p) as Record<string, unknown>)['overrideMass']).toBeUndefined();
    expect((presetPatch('nosecone', { ...p, mass: 0.01 }) as Record<string, unknown>)['overrideMass'])
      .toBe(0.01);
  });
});

/**
 * The custom-preset CSV round trip (his 18 September item 28), fixed
 * 2026-09-21. Four defects, three of them silent: a lower-case kind imported
 * and then appeared in no picker; a blank material type made a canopy BULK and
 * threw its fabric weight away; a material name with no density skipped the
 * material block and imported as a clean success; and a parachute's packed
 * size had no columns at all, so an exported canopy came back unable to be
 * fit-checked against the airframe it came out of.
 */
describe('preset CSV round trip', () => {
  const HEAD = 'kind,manufacturer,partNo,description,materialName,materialType,'
    + 'materialDensity,diameter,packedDiameter,packedLength';
  const csvOf = (row: string) => `${HEAD}\n${row}`;

  it('canonicalises a lower-case kind, so the row reaches its picker', () => {
    const [p] = csvToPresets(csvOf('parachute,Acme,X1,Chute,Ripstop,,0.067,0.6,0.05,0.12'));
    expect(p!.kind).toBe('Parachute');
  });

  it('leaves a kind it does not know exactly as typed', () => {
    const [p] = csvToPresets(csvOf('Widget,Acme,X1,Thing,,,,,,'));
    expect(p!.kind).toBe('Widget');
  });

  it('gives a canopy SURFACE material when the type cell is blank', () => {
    // BULK on a parachute threw the fabric weight away and wrote a
    // meaningless bulk density onto the part instead.
    const [p] = csvToPresets(csvOf('Parachute,Acme,X1,Chute,Ripstop,,0.067,0.6,0.05,0.12'));
    expect(p!.material!.type).toBe('SURFACE');
  });

  it('still gives a body tube BULK', () => {
    const [p] = csvToPresets(csvOf('BodyTube,Acme,BT-50,Tube,Kraft,,680,0.024,,'));
    expect(p!.material!.type).toBe('BULK');
  });

  it('keeps an explicit material type over the derived one', () => {
    const [p] = csvToPresets(csvOf('Parachute,Acme,X1,Chute,Ripstop,BULK,0.067,0.6,,'));
    expect(p!.material!.type).toBe('BULK');
  });

  it('carries a half-filled material through so the picker can REFUSE it', () => {
    // The old `&&` skipped the block entirely: the row imported clean and the
    // part kept its old weight under a new material's name.
    const [named] = csvToPresets(csvOf('BodyTube,Acme,BT-50,Tube,Kraft,BULK,,0.024,,'));
    expect(named!.material).toBeDefined();
    expect(named!.material!.density).toBe(0);
    const [numbered] = csvToPresets(csvOf('BodyTube,Acme,BT-51,Tube,,BULK,680,0.024,,'));
    expect(numbered!.material).toBeDefined();
    expect(numbered!.material!.name).toBe('');
  });

  it('round-trips a canopy packed size', () => {
    const csv = presetsToCsv([{
      kind: 'Parachute', manufacturer: 'Acme', partNo: 'X1', description: 'Chute',
      diameter: 0.6, packedDiameter: 0.05, packedLength: 0.12,
    } as never]);
    expect(csv.split('\n')[0]).toContain('packedDiameter');
    const [back] = csvToPresets(csv);
    expect(back!['packedDiameter']).toBeCloseTo(0.05, 12);
    expect(back!['packedLength']).toBeCloseTo(0.12, 12);
  });
});

/**
 * Two catalogue picks in a row (audit 2026-09-22, HIGH). `presetPatch` is
 * MERGED over the node, so until this fix a field the second row lacked kept
 * whatever the first row had put there. Measured through the kernel before the
 * fix: Fruity Chutes IFC-030-S then Apogee 29093 flew a Cd of 2.09 (the Fruity
 * Chutes rating over its own vent, on the Apogee canopy) and landed at 1.14 m/s
 * where the same canopy picked fresh lands at 1.84; an Apogee 19490 thin-wall
 * nose picked after a solid cone weighed 975.8 g instead of 86.5 g.
 */
describe('presetPatch describes the whole part — a second pick keeps nothing of the first', () => {
  const row = (kind: string, pn: string) => {
    const p = db.find((x) => x.kind === kind && x.partNo === pn);
    expect(p, `${kind} ${pn} has gone from the database`).toBeTruthy();
    return p!;
  };
  /** A pick the way PresetPicker makes one: the node it replaces and the catalogue it shows. */
  const pick = (node: ComponentNode, p: Preset): ComponentNode =>
    ({ ...node, ...presetPatch(node.type, p, { node, presets: db }) }) as ComponentNode;
  const fresh = (type: ComponentNode['type'], p: Preset) => pick({ type, id: 'x' } as ComponentNode, p);

  it('IFC-030-S then Apogee 29093: the Apogee canopy flies the default Cd with no vent', () => {
    const ifc = row('Parachute', 'IFC-030-S');
    const apogee = row('Parachute', '29093');
    expect(apogee['dragCoefficient']).toBeUndefined(); // the premise: a row with no rated Cd
    const first = fresh('parachute', ifc);
    expect(first['cd']).toBe(2.2);
    expect(first['spillHoleDiameter']).toBeGreaterThan(0);
    const second = pick(first, apogee);
    // Exactly what picking 29093 on a fresh canopy gives — nothing of IFC-030-S.
    const direct = fresh('parachute', apogee);
    for (const k of ['cd', 'spillHoleDiameter', 'lineCount', 'lineLength', 'overrideMass',
      'surfaceDensity', 'lineDensity', 'diameter']) {
      expect(second[k], k).toEqual(direct[k]);
    }
    expect(second['cd']).toBeUndefined();
    expect(second['spillHoleDiameter']).toBeUndefined();
  });

  it('the Cd and its vent still move together — a vented row after an unvented one takes both', () => {
    const ifc = row('Parachute', 'IFC-030-S');
    const second = pick(fresh('parachute', row('Parachute', '29093')), ifc);
    expect(second['cd']).toBe(2.2);
    expect(second['spillHoleDiameter']).toBeCloseTo(ifc['spillHoleDiameter'] as number, 12);
  });

  it('line data and materials the second row lacks go back to the defaults', () => {
    const noLine = db.find((x) => x.kind === 'Parachute' && !x.lineMaterial);
    expect(noLine, 'no canopy row without a line material left to test with').toBeTruthy();
    const second = pick(fresh('parachute', row('Parachute', 'IFC-030-S')), noLine!);
    expect(second['lineMaterialName']).toBeUndefined();
    expect(second['lineDensity']).toBeUndefined();
  });

  it('a row with no mass clears the previous part’s catalogue mass', () => {
    const massed = db.find((x) => x.kind === 'NoseCone' && typeof x.mass === 'number')!;
    const unmassed = row('NoseCone', '19490');
    expect(unmassed.mass).toBeUndefined();
    const first = { ...fresh('nosecone', massed), overrideSubcomponentsMass: true } as ComponentNode;
    expect(first['overrideMass']).toBe(massed.mass);
    const second = pick(first, unmassed);
    expect(second['overrideMass']).toBeUndefined();
    expect(second['overrideSubcomponentsMass']).toBeUndefined();
  });

  /**
   * Review of the audit 2026-09-22 fix: it cleared EVERY override on a row with
   * no mass, so a weight the user typed went with the old part's catalogue
   * mass — on 1,197 of the 1,308 body-tube rows. Desktop never touches the mass
   * of anything but a parachute on a preset load; the app clears only the
   * catalogue mass it wrote itself.
   */
  it('a mass the user typed survives a pick of a part with none — desktop keeps it too', () => {
    const noMassTube = db.find((x) => x.kind === 'BodyTube' && x.mass === undefined)!;
    const weighed = { type: 'bodytube', id: 'b', overrideMass: 0.25, overrideSubcomponentsMass: true } as ComponentNode;
    const after = pick(weighed, noMassTube);
    expect(after['overrideMass']).toBe(0.25);
    expect(after['overrideSubcomponentsMass']).toBe(true);
    // Linked to a massed row, but not at that row's mass: the user retyped it.
    const massed = db.find((x) => x.kind === 'NoseCone' && typeof x.mass === 'number')!;
    const retyped = { ...fresh('nosecone', massed), overrideMass: massed.mass! * 1.3 } as ComponentNode;
    expect(pick(retyped, row('NoseCone', '19490'))['overrideMass']).toBeCloseTo(massed.mass! * 1.3, 12);
  });

  it('a parachute goes back to its computed mass on a row with none, as desktop’s does', () => {
    const noMass = db.find((x) => x.kind === 'Parachute' && x.mass === undefined)!;
    const typed = { type: 'parachute', id: 'p', overrideMass: 0.045 } as ComponentNode;
    expect(pick(typed, noMass)['overrideMass']).toBeUndefined();
  });

  it('a catalogue mass is never a subtree’s mass, and never replaces an assembly the user weighed', () => {
    const tube = row('BodyTube', '10063');
    expect(tube.mass).toBeGreaterThan(0);
    // The flag riding on the PREVIOUS part's catalogue mass (the state the
    // unfixed patch left): the new part's mass lands and the flag goes, or the
    // tube's 5.8 g would be the weight of everything under it.
    const prevTube = db.find((x) => x.kind === 'BodyTube' && typeof x.mass === 'number' && x.partNo !== '10063')!;
    const flagged = { ...fresh('bodytube', prevTube), overrideSubcomponentsMass: true } as ComponentNode;
    const next = pick(flagged, tube);
    expect(next['overrideMass']).toBe(tube.mass);
    expect(next['overrideSubcomponentsMass']).toBeUndefined();
    // A section the user weighed as a whole keeps their figure.
    const section = { type: 'bodytube', id: 'b', overrideMass: 0.25, overrideSubcomponentsMass: true } as ComponentNode;
    const kept = pick(section, tube);
    expect(kept['overrideMass']).toBe(0.25);
    expect(kept['overrideSubcomponentsMass']).toBe(true);
    // With nothing to go on, the patch still never leaves the flag under a catalogue mass.
    const bare = presetPatch('bodytube', tube);
    expect('overrideSubcomponentsMass' in bare && bare['overrideSubcomponentsMass'] === undefined).toBe(true);
  });

  it('holdsCatalogueMass: the linked row’s own mass, through an alternate part number, to 0.01 %', () => {
    const massed = db.find((x) => x.kind === 'NoseCone' && typeof x.mass === 'number')!;
    const linked = fresh('nosecone', massed);
    expect(holdsCatalogueMass(linked, db)).toBe(true);
    expect(holdsCatalogueMass({ ...linked, overrideMass: massed.mass! * (1 + 5e-5) } as ComponentNode, db)).toBe(true);
    expect(holdsCatalogueMass({ ...linked, overrideMass: massed.mass! * 1.01 } as ComponentNode, db)).toBe(false);
    expect(holdsCatalogueMass({ type: 'nosecone', id: 'n', overrideMass: massed.mass } as ComponentNode, db)).toBe(false);
    const alt = db.find((x) => Array.isArray(x['altPartNos']) && typeof x.mass === 'number'
      && KIND_FOR_TYPE.parachute === x.kind)!;
    expect(alt, 'no massed canopy with an alternate part number left to test with').toBeTruthy();
    const viaAlt = {
      type: 'parachute', id: 'p', overrideMass: alt.mass,
      presetManufacturer: alt.manufacturer, presetPartNo: (alt['altPartNos'] as string[])[0],
    } as ComponentNode;
    expect(holdsCatalogueMass(viaAlt, db)).toBe(true);
  });

  it('a hollow row after a solid one is hollow: `filled` is written either way', () => {
    const solid = db.find((x) => x.kind === 'NoseCone' && x['filled'] === true && x.mass === undefined)!;
    expect(pick(fresh('nosecone', solid), row('NoseCone', '19490'))['filled']).toBe(false);
    const solidTr = db.find((x) => x.kind === 'Transition' && x['filled'] === true)!;
    const hollowTr = db.find((x) => x.kind === 'Transition' && x['filled'] !== true)!;
    expect(pick(fresh('transition', solidTr), hollowTr)['filled']).toBe(false);
  });

  it('a named shape brings its own default parameter, as desktop’s loadFromPreset does', () => {
    const cone = { type: 'nosecone', id: 'n', shape: 'power', shapeParameter: 0.5 } as ComponentNode;
    const second = pick(cone, row('NoseCone', '19490'));
    expect(second['shape']).toBe('ogive');
    expect(second['shapeParameter']).toBeUndefined();
    const tr = { type: 'transition', id: 't', shape: 'haack', shapeParameter: 0.33, clipped: false } as ComponentNode;
    const tr2 = pick(tr, db.find((x) => x.kind === 'Transition')!);
    expect(tr2['shapeParameter']).toBeUndefined();
    expect(tr2['clipped']).toBeUndefined();
  });

  it('the 19490 weighs as a thin wall after a solid cone, through the kernel', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const solid = db.find((x) => x.kind === 'NoseCone' && x['filled'] === true && x.mass === undefined
      && Math.abs((x['outsideDiameter'] as number) - 0.0762) < 0.002)!;
    const massOf = (n: ComponentNode) => OrkRocket.buildTree(engineTree({
      name: 't', components: [{ type: 'stage', id: 's', children: [n] } as ComponentNode],
    })).staticInfo().mass;
    const twice = massOf(pick(fresh('nosecone', solid), row('NoseCone', '19490')));
    const once = massOf(fresh('nosecone', row('NoseCone', '19490')));
    // Measured 2026-09-22: 86.5 g either way (975.8 g after the solid cone before the fix).
    expect(twice).toBeCloseTo(once, 9);
    expect(twice).toBeLessThan(0.1);
  }, 60000);

  it('a catalogue LINK on import still only fills — the clears never erase a file value', () => {
    // applyPresetLinks feeds on the same patch; an undefined entry must be a
    // no-op there, or linking a no-Cd row would wipe the Cd a file stated.
    const node = { type: 'parachute', id: 'p', name: 'Main', cd: 1.3, lineCount: 8 } as ComponentNode;
    applyPresetLinks([{ node, manufacturer: 'Apogee', partNo: '29093' }], db, []);
    expect(node['cd']).toBe(1.3);
    expect(node['lineCount']).toBe(8);
    expect('spillHoleDiameter' in node).toBe(false);
  });
});

/**
 * A stated wall thickness is a statement that the part is HOLLOW (audit
 * 2026-09-22). The .ork reader marks a hollow nose only by its numeric
 * <thickness> (desktop's setThickness clears `filled`), so "filled is unset" on
 * such a node is not "the file left it unset" — and the catalogue's
 * `filled: true` used to land on it: 96.1 g → 377.2 g, measured on the desktop
 * fixture rocksimTestRocket1.rkt's nose re-badged as Madcow's 2.6" fiberglass
 * cone with its known mass switched off.
 */
describe('applyPresetLinks never makes a hollow part solid', () => {
  const madcow = () => {
    const p = db.find((x) => x.kind === 'NoseCone' && x.manufacturer === 'Madcow'
      && x['filled'] === true && /2\.6" Fiberglass/.test(x.partNo));
    expect(p, 'the filled Madcow 2.6" cone has gone from the database').toBeTruthy();
    return p!;
  };

  it('an .ork-shaped hollow nose (thickness stated, filled unset) stays hollow, and the note says so', () => {
    const row = madcow();
    const node = { type: 'nosecone', id: 'n', name: 'Nose', thickness: 0.002 } as ComponentNode;
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, manufacturer: row.manufacturer, partNo: row.partNo }], db, notes)).toBe(1);
    expect(node['filled']).toBeUndefined();
    expect(notes[0]).not.toMatch(/took[^;]*solid/);
    // A disagreement about the same fact, so the conflict marker names it.
    expect(notes.some((n) => /disagrees/.test(n) && /Nose: [^;]*solid/.test(n))).toBe(true);
  });

  it('a node with neither a wall nor a flag still takes the catalogue’s solid', () => {
    const row = madcow();
    const node = { type: 'nosecone', id: 'n', name: 'Nose' } as ComponentNode;
    applyPresetLinks([{ node, manufacturer: row.manufacturer, partNo: row.partNo }], db, []);
    expect(node['filled']).toBe(true);
  });

  it('a hollow row never writes `filled: false` onto an unset node, and never notes it', () => {
    const hollow = db.find((x) => x.kind === 'NoseCone' && x.partNo === '19490')!;
    const node = { type: 'nosecone', id: 'n', name: 'Nose' } as ComponentNode;
    const notes: string[] = [];
    applyPresetLinks([{ node, manufacturer: hollow.manufacturer, partNo: hollow.partNo }], db, notes);
    expect('filled' in node).toBe(false);
    expect(notes[0]).not.toMatch(/solid/);
  });
});
