// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { CDX1_ENGINE_EXPORT, exportCdx1, importCdx1, rasaeroManufacturerAbbrev } from './rasaeroFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', name), 'utf8');

function flatten(nodes: ComponentNode[]): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

describe('RASAero import — desktop fixture files', () => {
  it('imports the three-stage rocket as three stages', () => {
    const r = importCdx1(fixture('Three-stage rocket.CDX1'));
    expect(r.tree.components.length).toBe(3);
    expect(r.tree.components.map((s) => s.name)).toEqual(['Sustainer', 'Booster', 'Booster 2']);
    // Every booster stage has a body tube.
    for (const st of r.tree.components.slice(1)) {
      expect((st.children ?? []).some((c) => c.type === 'bodytube')).toBe(true);
    }
  });

  it('imports the complex two-stage design with inch→meter conversion', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.tree.components.length).toBe(2);
    const all = flatten(r.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    // Tangent Ogive → ogive with shape parameter 1.
    expect(nose['shape']).toBe('ogive');
    // RASAero geometry is inches: every radius must be plausible meters.
    for (const c of all) {
      for (const k of ['aftRadius', 'outerRadius', 'foreRadius']) {
        if (typeof c[k] === 'number') {
          expect(c[k] as number).toBeGreaterThan(0.001);
          expect(c[k] as number).toBeLessThan(0.5);
        }
      }
    }
    // Fins exist, and fins on the boat tail became freeform.
    expect(all.some((c) => c.type === 'trapezoidfinset')).toBe(true);
    const transitions = all.filter((c) => c.type === 'transition');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every((t) => t['shape'] === 'conical')).toBe(true);
    const transFins = transitions.flatMap((t) => (t.children ?? []).filter((c) => c.type.endsWith('finset')));
    expect(transFins.every((f) => f.type === 'freeformfinset')).toBe(true);

    // Recovery slots became parachutes with deployment settings.
    const chutes = all.filter((c) => c.type === 'parachute');
    expect(chutes.length).toBe(2);
    expect(chutes.some((c) => c['deployEvent'] === 'apogee')).toBe(true);
    expect(chutes.some((c) => c['deployEvent'] === 'altitude')).toBe(true);

    // Honest notes: mass caveat. Motors now import as flight configurations
    // (see the simulations tests), so the old "add a mount" hint is gone.
    expect(r.notes.join(' ')).toMatch(/no material or wall data/);
    expect(r.notes.join(' ')).not.toMatch(/Motors in the RASAero file/);
  });

  it('imports the show-off design with its launch lug', () => {
    const r = importCdx1(fixture('Show-off.CDX1'));
    const all = flatten(r.tree.components);
    expect(all.some((c) => c.type === 'launchlug')).toBe(true);
  });
});

describe('RASAero import — supersonic airfoils, launch site, simulations', () => {
  it('imports the ARCAS double-wedge airfoil, deriving the TE chamfer', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['crossSection']).toBe('airfoil'); // desktop parity for supersonic sections
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(1.4863 / 39.37, 6); // FX1
    // TE = (Chord + TipChord)/2 − FX1; the file's stale <FX3> 0.465 matches nothing.
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.0326695, 6);
    expect(fins['finLeRadius']).toBeUndefined(); // LERadius 0
  });

  it('imports the ARCAS launch site in SI (pressure 0 = unset)', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    expect(r.launch!.launchAltitudeM).toBeCloseTo(3933 / 3.28084, 3); // FEET
    expect(r.launch!.temperatureC).toBeCloseTo((80 - 32) * 5 / 9, 6); // °F
    expect(r.launch!.launchRodLengthM).toBeCloseTo(12 / 3.28084, 4); // FEET, not inches
    expect(r.launch!.launchRodAngleDeg).toBe(0);
    expect(r.launch!.windAverage).toBe(0);
    expect(r.launch!.pressureHPa).toBeNull(); // unset → explicit ISA, never absent
  });

  it('reports what the ARCAS import dropped, and invents no motors', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    // Its only <Simulation> carries no engines: no mounts, no configurations.
    expect(r.motors).toEqual({});
    expect(r.configs).toEqual([]);
    expect(r.chosenConfigId).toBeNull();
    const joined = r.notes.join(' ');
    expect(joined).toMatch(/protuberance/i);
    expect(joined).toMatch(/BluntRadius/);
  });

  /**
   * §7.5e. Chuck Rogers' ARCAS carries `<StreamlinedWithBaseDrag>0.178</…>` —
   * the four fin-root anchors, entered as one total frontal area in square
   * inches. It used to reach us as a note and nothing else, and the validation
   * fixture records the omission as "kernel CD reads LOW".
   */
  it('imports the ARCAS <Protuberance> as a real component, area exact', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const prots = flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance');
    expect(prots).toHaveLength(1);
    const p = prots[0]!;
    expect(p['dragClass']).toBe('streamlinedbase');
    expect(p['count']).toBe(1);
    // Equal-area square (Rogers' own convention), so the area survives exactly.
    const IN2 = 39.37 * 39.37;
    expect((p['width'] as number) * (p['height'] as number) * IN2).toBeCloseTo(0.178, 9);
    expect(p['width']).toBe(p['height']);
    // It hangs off the body tube that declared it, not the stage.
    const tube = flatten(r.tree.components).find((c) => c.type === 'bodytube')!;
    expect((tube.children ?? []).some((c) => c.id === p.id)).toBe(true);
    // …and the note SAYS it imported, with the area, instead of the old
    // "protuberance drag is not modeled".
    expect(r.notes.join(' ')).toContain('Imported 1 RASAero protuberance on Body tube (0.1780 in²)');
    expect(r.notes.join(' ')).not.toMatch(/protuberance drag is not modeled/);
  });

  it('leaves a design with no <Protuberance> block untouched', () => {
    for (const f of ['RMA53D02 - 2.CDX1', 'Show-off.CDX1', 'Three-stage rocket.CDX1']) {
      const r = importCdx1(fixture(f));
      expect(flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance'))
        .toHaveLength(0);
    }
  });

  /**
   * The desktop's own two-stage sample carries BOTH kinds on one tube:
   * 0.25 in² with base drag and 0.25 in² of inclined flat plate at 30°.
   * Two entries, two components, and the plate angle arrives in RADIANS.
   */
  it('imports both protuberance kinds from one <Protuberance> block', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const prots = flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance');
    expect(prots).toHaveLength(2);
    const IN2 = 39.37 * 39.37;
    const base = prots.find((p) => p['dragClass'] === 'streamlinedbase')!;
    const plate = prots.find((p) => p['dragClass'] === 'plate')!;
    expect((base['width'] as number) * (base['height'] as number) * IN2).toBeCloseTo(0.25, 9);
    expect((plate['width'] as number) * (plate['height'] as number) * IN2).toBeCloseTo(0.25, 9);
    expect(plate['plateAngle']).toBeCloseTo(Math.PI / 6, 12); // 30° as radians
    expect(base['plateAngle']).toBeUndefined();
    // Straight back out, both slots, degrees at the file boundary again. Only
    // the stage that owns them — this two-stage sample's BOOSTER has extra
    // transitions the exporter refuses for unrelated reasons.
    const owner = r.tree.components.find(
      (s) => flatten([s]).some((c) => c.id === base.id))!;
    const out = exportCdx1({ name: 'Complex', tree: { name: 'Complex', components: [owner] } });
    expect(out).toMatch(/<StreamlinedWithBaseDrag>0\.25<\/StreamlinedWithBaseDrag>/);
    expect(out).toMatch(/<InclinedPlate1Angle>30<\/InclinedPlate1Angle>/);
    expect(out).toMatch(/<InclinedPlate1FrontalArea>0\.25<\/InclinedPlate1FrontalArea>/);
  });

  it('round-trips protuberances back out to <Protuberance>, summed per class', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const out = exportCdx1({ name: 'ARCAS', tree: r.tree });
    expect(out).toMatch(/<Protuberance>/);
    expect(out).toMatch(/<StreamlinedWithBaseDrag>0\.178<\/StreamlinedWithBaseDrag>/);
    expect(out).toMatch(/<StreamlinedNoBaseDrag>0<\/StreamlinedNoBaseDrag>/);
    expect(out).toMatch(/<InclinedPlate1Angle>0<\/InclinedPlate1Angle>/);
    // …and re-importing our own output gives the same area back.
    const back = importCdx1(out);
    const p = flatten(back.tree.components).find((c) => (c.type as string) === 'protuberance')!;
    const IN2 = 39.37 * 39.37;
    expect((p['width'] as number) * (p['height'] as number) * IN2).toBeCloseTo(0.178, 9);
  });

  it('exports inclined plates grouped by angle into RASAero\'s two slots', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const tube = flatten(r.tree.components).find((c) => c.type === 'bodytube')!;
    const plate = (deg: number, side: number, count: number): ComponentNode => ({
      type: 'protuberance', dragClass: 'plate', plateAngle: (deg * Math.PI) / 180,
      width: side, height: side, length: side, count, mass: 0,
      position: { method: 'middle', offset: 0 },
    } as unknown as ComponentNode);
    // 30° twice (must SUM), 60° once, 20° once — three distinct angles into two
    // slots, so the smallest total folds into its nearest kept angle.
    const s = 0.01;
    tube.children = [...(tube.children ?? []),
      plate(30, s, 2), plate(30, s, 1), plate(60, s, 4), plate(20, s, 1)];
    const out = exportCdx1({ name: 'ARCAS', tree: r.tree });
    const IN2 = 39.37 * 39.37;
    const a = (n: number) => n * s * s * IN2;
    const angle1 = /<InclinedPlate1Angle>([\d.]+)<\/InclinedPlate1Angle>/.exec(out)![1]!;
    const area1 = /<InclinedPlate1FrontalArea>([\d.]+)<\/InclinedPlate1FrontalArea>/.exec(out)![1]!;
    const angle2 = /<InclinedPlate2Angle>([\d.]+)<\/InclinedPlate2Angle>/.exec(out)![1]!;
    const area2 = /<InclinedPlate2FrontalArea>([\d.]+)<\/InclinedPlate2FrontalArea>/.exec(out)![1]!;
    expect(Number(angle1)).toBeCloseTo(60, 1); // 4 units — the largest
    expect(Number(area1)).toBeCloseTo(a(4), 3);
    expect(Number(angle2)).toBeCloseTo(30, 1); // 2 + 1 summed
    // The lone 20° (1 unit) folds into 30°, the nearest kept angle: 3 + 1 = 4.
    expect(Number(area2)).toBeCloseTo(a(4), 3);
    // Nothing lost: the two slots carry every square inch that went in.
    expect(Number(area1) + Number(area2)).toBeCloseTo(a(8), 3);
  });

  it('imports the ARCAS Mach-Alt conditions table, deduplicated and SI', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    // The file writes its ten rows SIX times over (60 <Item>s) — RASAero's
    // editor repeats the block per grid page. Undeduplicated, the repeats make
    // the engine's Mach interpolator walk a non-monotone ladder.
    expect(r.machAlt).toHaveLength(10);
    expect(r.machAlt!.map(([m]) => m)).toEqual([0, 0.42, 0.9, 1.05, 1.2, 1.5, 2, 4, 5, 25]);
    // Feet → metres, and Mach-ascending (the engine interpolates assuming it).
    expect(r.machAlt![2]![1]).toBeCloseTo(25000 / 3.28084, 3); // 25 kft at M0.9
    expect(r.machAlt![9]![1]).toBeCloseTo(122500 / 3.28084, 3);
    for (let i = 1; i < r.machAlt!.length; i++) {
      expect(r.machAlt![i]![0]).toBeGreaterThan(r.machAlt![i - 1]![0]);
    }
    // Same table the validation harness carries by hand for the two ARCAS
    // cells (validation/anchors.json `machAlt`, ft already converted) — so the
    // in-app comparison now runs at the harness's own tunnel-Re conditions
    // without anyone retyping them. Agreement to 1 cm.
    const harness: [number, number][] = [[0, 0], [0.42, 0.3], [0.9, 7620], [1.05, 9296.4],
      [1.2, 10058.4], [1.5, 11277.6], [2, 13411.2], [4, 17983.2], [5, 19202.4]];
    for (const [i, [mach, altM]] of harness.entries()) {
      expect(r.machAlt![i]![0]).toBe(mach);
      expect(Math.abs(r.machAlt![i]![1] - altM)).toBeLessThan(0.01);
    }
    // And it's advertised, or nobody would know to switch conditions.
    expect(r.notes.join(' ')).toMatch(/Mach-Alt conditions table \(10 points/);
  });

  it('imports the RMA Mach-Alt table (already unique) and leaves table-less files alone', () => {
    const rma = importCdx1(fixture('RMA53D02 - 2.CDX1'));
    expect(rma.machAlt).toHaveLength(5);
    expect(rma.machAlt!.map(([m]) => m)).toEqual([0, 2.5, 5, 10, 25]);
    expect(rma.machAlt![2]![1]).toBeCloseTo(4750 / 3.28084, 3); // the one non-zero row
    // The note quotes the table's HIGHEST altitude, not its last row (which is
    // back at sea level here).
    expect(rma.notes.join(' ')).toMatch(/5 points, to 4750 ft/);
    // Files with no <MachAlt> element carry no table and gain no note.
    const plain = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(plain.machAlt).toBeUndefined();
    expect(plain.notes.join(' ')).not.toMatch(/Mach-Alt/);
  });

  it('imports the RMA hexagonal-blunt-base airfoil (no TE chamfer)', () => {
    const r = importCdx1(fixture('RMA53D02 - 2.CDX1'));
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('hexbluntbase');
    expect(fins['crossSection']).toBe('airfoil');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(0.189 / 39.37, 7);
    expect(fins['airfoilTeDiamond']).toBeUndefined();
  });

  it('turns each engine-carrying simulation into a flight configuration', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.configs.length).toBe(2);
    expect(r.chosenConfigId).toBe(r.configs[0]!.id);
    expect(r.configs[0]!.isDefault).toBe(true);
    expect(r.configs[1]!.isDefault).toBe(false);

    // RASAero's mount for a stage is its aft-most body tube.
    const lastTube = (stage: ComponentNode): ComponentNode => {
      const tubes = (stage.children ?? []).filter((c) => c.type === 'bodytube');
      return tubes[tubes.length - 1]!;
    };
    const sustainerMount = lastTube(r.tree.components[0]!);
    const boosterMount = lastTube(r.tree.components[1]!);
    expect(sustainerMount['motorMount']).toBe(true);
    expect(boosterMount['motorMount']).toBe(true);

    const cfg1 = r.configs[0]!;
    const sus = cfg1.motors[sustainerMount.id!]!;
    expect(sus.designation).toBe('J90W');
    expect(sus.manufacturer).toBe('AT');
    expect(sus.delay).toBe(Infinity); // RASAero is apogee-deploy: plugged
    expect(sus.ignitionEvent).toBe('burnout'); // upper stage lights at booster burnout
    const boo = cfg1.motors[boosterMount.id!]!;
    expect(boo.designation).toBe('I170G');
    expect(boo.ignitionEvent).toBe('automatic'); // bottom stage
    expect(boo.delay).toBe(0);
    // IncludeBooster1 True: separation 2 s after burnout, keyed by the stage.
    expect(cfg1.separations[r.tree.components[1]!.id!])
      .toEqual({ separationEvent: 'burnout', separationDelay: 2 });

    const cfg2 = r.configs[1]!;
    expect(cfg2.motors[sustainerMount.id!]!.designation).toBe('J180T');
    expect(cfg2.motors[boosterMount.id!]!.designation).toBe('I215R');

    // The first engine-carrying simulation is the applied configuration.
    expect(r.motors).toEqual(cfg1.motors);
  });

  it('bakes the chosen configuration separation onto the booster stage node', () => {
    // App.applyImported applies configs, not stage settings — a fresh import
    // must carry burnout + delay on the node itself, or the kernel separates
    // on its default (ejection charge, 0 s).
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const booster = r.tree.components[1]!;
    expect(booster['separationEvent']).toBe('burnout');
    expect(booster['separationDelay']).toBe(2); // Booster1SeparationDelay
  });

  it('flies sustainer-only when IncludeBooster1 is False (desktop enableMotorMount parity)', () => {
    const xml = fixture('Complex.Two-Stage.CDX1')
      .replace(/<IncludeBooster1>True<\/IncludeBooster1>/g, '<IncludeBooster1>False</IncludeBooster1>');
    const r = importCdx1(xml);
    expect(r.configs.length).toBe(2);
    const lastTube = (stage: ComponentNode): ComponentNode => {
      const tubes = (stage.children ?? []).filter((c) => c.type === 'bodytube');
      return tubes[tubes.length - 1]!;
    };
    const sustainerMount = lastTube(r.tree.components[0]!);
    for (const cfg of r.configs) {
      expect(Object.keys(cfg.motors)).toEqual([sustainerMount.id]);
      expect(cfg.separations).toEqual({});
    }
    // The excluded booster's tube gets no mount flag and its stage no separation.
    expect(lastTube(r.tree.components[1]!)['motorMount']).toBeUndefined();
    expect(r.tree.components[1]!['separationEvent']).toBeUndefined();
    expect(r.tree.components[1]!['separationDelay']).toBeUndefined();
  });
});

describe('RASAero export', () => {
  const design = {
    name: 'CdxOut',
    tree: {
      name: 'CdxOut',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3, aftRadius: 0.0508, thickness: 0.002, shape: 'haack', shapeParameter: 0 },
            {
              type: 'bodytube' as const, id: 'b', length: 1.0, outerRadius: 0.0508, thickness: 0.001,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 4, rootChord: 0.15, tipChord: 0.07, sweep: 0.05, height: 0.11, thickness: 0.004, crossSection: 'airfoil', position: { method: 'bottom' as const, offset: 0 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.9, deployEvent: 'apogee' },
              ],
            },
          ],
        },
      ],
    },
    launchMassKg: 4.5,
    launchCgM: 0.85,
  };

  it('writes a valid CDX1 that round-trips through our importer', () => {
    const xml = exportCdx1(design);
    expect(xml).toContain('<FileVersion>2</FileVersion>');
    expect(xml).toContain('<Shape>Von Karman Ogive</Shape>');
    // 4-inch airframe: 0.0508 m radius → 4 in diameter (trailing zeros stripped).
    expect(xml).toMatch(/<Diameter>4(\.000\d?)?<\/Diameter>/);
    expect(xml).toContain('<AirfoilSection>Subsonic NACA</AirfoilSection>');
    expect(xml).toContain('<SustainerLaunchWt>9.9208</SustainerLaunchWt>');

    const back = importCdx1(xml);
    const all = flatten(back.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    expect(nose['shape']).toBe('haack');
    expect(nose['length']).toBeCloseTo(0.3, 3);
    const fins = all.find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['finCount']).toBe(4);
    expect(fins['rootChord']).toBeCloseTo(0.15, 3);
    const chute = all.find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('apogee');
  });

  it('rejects fin counts RASAero cannot hold (3–8)', () => {
    const bad = structuredClone(design);
    (bad.tree.components[0]!.children![1]!.children![0] as ComponentNode)['finCount'] = 2;
    expect(() => exportCdx1(bad)).toThrow(/3–8 fins/);
  });

  it('converts trapezoid-shaped freeform fins instead of dropping them', () => {
    const d = {
      name: 'FF',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001,
              children: [{
                type: 'freeformfinset' as const, id: 'f', finCount: 3, thickness: 0.003,
                points: [[0, 0], [0.04, 0.06], [0.09, 0.06], [0.12, 0]] as [number, number][],
                position: { method: 'bottom' as const, offset: 0 },
              }],
            },
          ],
        }],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<Fin>');
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['rootChord']).toBeCloseTo(0.12, 3);
    expect(fins['tipChord']).toBeCloseTo(0.05, 3);
    expect(fins['sweep']).toBeCloseTo(0.04, 3);
    expect(fins['height']).toBeCloseTo(0.06, 3);
  });

  it('throws (never silently drops) fins RASAero cannot represent', () => {
    const withFin = (fin: ComponentNode) => ({
      name: 'X',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            { type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001, children: [fin] },
          ],
        }],
      },
    });
    expect(() => exportCdx1(withFin({
      type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.02, 0.04], [0.05, 0.06], [0.09, 0.05], [0.12, 0]],
    } as ComponentNode))).toThrow(/trapezoid/i);
    expect(() => exportCdx1(withFin({
      type: 'ellipticalfinset', id: 'f', finCount: 3, rootChord: 0.08, height: 0.05, thickness: 0.003,
    } as ComponentNode))).toThrow(/elliptical/i);
  });

  it('round-trips booster shoulder and boat-tail geometry', () => {
    const d = {
      name: 'B',
      tree: {
        components: [
          {
            type: 'stage' as const, id: 's0', name: 'Sustainer',
            children: [
              { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b0', length: 0.5, outerRadius: 0.02, thickness: 0.001 },
            ],
          },
          {
            type: 'stage' as const, id: 's1', name: 'Booster',
            children: [
              { type: 'transition' as const, id: 'sh', length: 0.05, foreRadius: 0.02, aftRadius: 0.03, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001 },
              { type: 'transition' as const, id: 'bt', length: 0.06, foreRadius: 0.03, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
            ],
          },
        ],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<ShoulderLength>1.9685</ShoulderLength>'); // 0.05 m in inches
    const back = importCdx1(xml);
    const booster = back.tree.components[1]!;
    const trans = (booster.children ?? []).filter((c) => c.type === 'transition');
    expect(trans.length).toBe(2);
    expect(trans[0]!['length']).toBeCloseTo(0.05, 3);
    expect(trans[1]!['length']).toBeCloseTo(0.06, 3);
    expect(trans[1]!['aftRadius']).toBeCloseTo(0.02, 3);
  });

  it('rejects non-conical transitions', () => {
    const bad = structuredClone(design);
    const children = bad.tree.components[0]!.children! as ComponentNode[];
    children.push({
      type: 'transition', id: 't', length: 0.1, foreRadius: 0.0508, aftRadius: 0.03, shape: 'ogive',
    } as ComponentNode);
    expect(() => exportCdx1(bad)).toThrow(/conical/);
  });

  it('round-trips a double-wedge supersonic airfoil (AirfoilSection/LERadius/FX1)', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['airfoilSection'] = 'doublewedge';
    fin['finLeRadius'] = 0.002;
    fin['airfoilLeDiamond'] = 0.03;
    fin['airfoilTeDiamond'] = 0.08; // = (0.15 + 0.07)/2 − 0.03, RASAero-consistent
    const xml = exportCdx1(d);
    expect(xml).toContain('<AirfoilSection>Double Wedge</AirfoilSection>');
    expect(xml).toContain('<LERadius>0.0787</LERadius>'); // 0.002 m in inches
    expect(xml).toContain('<FX1>1.1811</FX1>'); // 0.03 m in inches
    expect(xml).toContain('<FX3>0</FX3>'); // derived for a double wedge, never written
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['finLeRadius']).toBeCloseTo(0.002, 5);
    expect(fins['airfoilLeDiamond']).toBeCloseTo(0.03, 5);
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.08, 5);
  });

  it('writes FX3 for a hexagonal airfoil and reads it back', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['airfoilSection'] = 'hexagonal';
    fin['airfoilLeDiamond'] = 0.03;
    fin['airfoilTeDiamond'] = 0.04;
    const xml = exportCdx1(d);
    expect(xml).toContain('<AirfoilSection>Hexagonal</AirfoilSection>');
    expect(xml).toContain('<FX3>1.5748</FX3>'); // 0.04 m in inches
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('hexagonal');
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.04, 5);
  });

  it('writes the launch panel into <LaunchSite> and round-trips it', () => {
    const launch = {
      launchAltitudeM: 3933 / 3.28084, temperatureC: 26.6667, pressureHPa: 850,
      launchRodAngleDeg: 5, launchRodLengthM: 3.6576, windAverage: 4.4704,
    };
    const xml = exportCdx1({ ...design, launch });
    expect(xml).toMatch(/<Altitude>3933(\.\d+)?<\/Altitude>/); // FEET
    expect(xml).toMatch(/<RodLength>12(\.\d+)?<\/RodLength>/); // FEET
    expect(xml).toMatch(/<Temperature>80(\.\d+)?<\/Temperature>/); // °F
    expect(xml).toMatch(/<WindSpeed>10(\.\d+)?<\/WindSpeed>/); // mph
    const back = importCdx1(xml);
    expect(back.launch!.launchAltitudeM).toBeCloseTo(3933 / 3.28084, 2);
    expect(back.launch!.pressureHPa).toBeCloseTo(850, 1);
    expect(back.launch!.launchRodAngleDeg).toBeCloseTo(5, 6);
    expect(back.launch!.launchRodLengthM).toBeCloseTo(3.6576, 4);
    expect(back.launch!.windAverage).toBeCloseTo(4.4704, 4);
  });

  it('defaults <LaunchSite> fields: null pressure→0, null temperature→59', () => {
    const xml = exportCdx1({ ...design, launch: { temperatureC: null, pressureHPa: null } });
    expect(xml).toContain('<Pressure>0</Pressure>'); // RASAero's own "unset"
    expect(xml).toContain('<Temperature>59</Temperature>'); // no unset in the format
    // No launch at all keeps the historical constants.
    const bare = exportCdx1(design);
    expect(bare).toContain('<Pressure>29.92</Pressure>');
    expect(bare).toContain('<Temperature>59</Temperature>');
    expect(bare).toContain('<RodLength>10</RodLength>');
  });

  it('preserves airfoil and launch site through ARCAS import→export→import', () => {
    const first = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const xml = exportCdx1({ name: first.name, tree: first.tree, launch: first.launch });
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(1.4863 / 39.37, 6);
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.0326695, 6);
    expect(back.launch!.launchAltitudeM).toBeCloseTo(first.launch!.launchAltitudeM!, 2);
    expect(back.launch!.temperatureC).toBeCloseTo(first.launch!.temperatureC!, 3);
    expect(back.launch!.launchRodLengthM).toBeCloseTo(first.launch!.launchRodLengthM!, 3);
    expect(back.launch!.pressureHPa).toBeNull(); // unset → explicit ISA, never absent
  });

  it('writes the Mach-Alt table back in feet — once each, not RASAero’s repeats', () => {
    const first = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const xml = exportCdx1({ name: first.name, tree: first.tree, machAlt: first.machAlt });
    expect(xml).toContain('<Item>0.9, 25000</Item>');
    expect(xml).toContain('<Item>25, 122500</Item>');
    expect(xml.match(/<Item>/g)).toHaveLength(10); // the file had 60
    const back = importCdx1(xml);
    expect(back.machAlt).toEqual(first.machAlt);
  });

  it('writes the empty <MachAlt> element when the design has no table', () => {
    // RASAero's own "unset", and what every export did before the table existed.
    expect(exportCdx1(design)).toContain('<MachAlt></MachAlt>');
  });

  it('keeps top/middle-positioned fins in place instead of snapping them to the tube bottom', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['position'] = { method: 'top', offset: 0 }; // fins at the tube TOP
    const back = importCdx1(exportCdx1(d));
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    // Tube 1.0 m, root 0.15 m: bottom-referenced offset −0.85 puts the fin
    // front edge at the tube top (the old code exported offset 0 = bottom).
    expect(fins.position?.method).toBe('bottom');
    expect(fins.position?.offset).toBeCloseTo(-0.85, 6);
  });

  it('every bundled .CDX1 fixture builds in the kernel', async () => {
    // The regression this pins: a fin with TipChord 0 on a boat tail produced a
    // repeated tip point, which the kernel reads as a self-intersection and
    // reports via a Java %g format TeaVM does not implement — buildTree died
    // with "Unknown format conversion: g" and the design had no CG/CP/Simulate.
    // Import-only assertions were green throughout, so the build is the test.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    for (const name of ['Complex.Two-Stage.CDX1', 'Show-off.CDX1', 'Three-stage rocket.CDX1',
      'ARCAS-Long - 2.CDX1', 'RMA53D02 - 2.CDX1']) {
      resetEngine();
      const r = importCdx1(fixture(name));
      const info = OrkRocket.buildTree(engineTree(r.tree)).staticInfo();
      expect(Number.isFinite(info.mass), `${name}: mass`).toBe(true);
      expect(info.mass, `${name}: mass > 0`).toBeGreaterThan(0);
      expect(Number.isFinite(info.cp), `${name}: cp`).toBe(true);
    }
  }, 120000);

  /**
   * ACCEPTANCE for the protuberance component (§7.5e), measured end to end:
   * open Chuck Rogers' own "ARCAS-Long - 2.CDX1", lower it, and see what the
   * kernel's total CD actually does — against the same design with the
   * protuberance removed.
   *
   * RE-MEASURED 2026-08-25 after the streamlined classes became
   * body-CD-referenced (RASAero's Streamlined Protuberance Method, TRF 197641
   * #1 — see treeModel.protuberanceCd):
   *
   *   frontal area 0.178 in² of a 2.25 in body (3.976 in² reference)
   *     ⇒ area ratio 0.044768
   *   body CD at Mach 0.3, fins stripped: 0.311401 without base drag,
   *     0.354024 with it
   *   ⇒ ΔCD = 0.354024 × 0.044768 = +0.0158488, at every Mach, exactly the
   *     override.  (It was +0.0098489 under the retired flat Cd 0.22.)
   *
   * Against RASAero's OWN per-Mach version of the same method on this design —
   * area ratio × the body CD at each Mach, Re-matched to the file's Mach–Alt
   * table — the true curve runs +0.0092973 (M3.0) to +0.0206119 (M0.05), and
   * is +0.015808 at M0.3, +0.015857 at M0.6, +0.018063 at M1.0, +0.013111 at
   * M1.8. Our Mach-flat scalar sits INSIDE that band everywhere and is exact
   * at M0.3–0.6; the retired 0.0098489 sat below the entire band except above
   * M2.9. That is the whole gain, and the remaining error is the Mach-flatness
   * the scalar `overrideCD` hook forces.
   *
   * And the things that must NOT move: friction, pressure and base CD, mass,
   * CG, CP, the reference diameter and the aerodynamic length — a protuberance
   * is drag and nothing else, exactly as RASAero prints it.
   */
  it('ARCAS: the imported protuberance delivers its frontal-area drag and nothing else', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { bodyDragReference, engineTree, protuberanceDeliveredCd, protuberanceFrontalArea, referenceArea } =
      await import('../tree/treeModel.js');
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const prot = flatten(r.tree.components).find((c) => (c.type as string) === 'protuberance')!;
    const expected = protuberanceDeliveredCd(r.tree, prot);
    expect(expected).toBeCloseTo(0.0158488, 7);
    // …and it IS the method, not a number: area ratio × this body's own CD.
    const body = bodyDragReference(r.tree);
    expect(body.measured).toBe(true);
    expect(body.noBase).toBeCloseTo(0.311401, 6);
    expect(body.withBase).toBeCloseTo(0.354024, 6);
    const ratio = protuberanceFrontalArea(prot) / referenceArea(r.tree);
    expect(ratio).toBeCloseTo(0.044768, 6);
    expect(expected).toBeCloseTo(ratio * body.withBase, 12);
    // The retired constant was 1.61× low on this design.
    expect(expected / (0.22 * ratio)).toBeCloseTo(1.6095, 3);

    const without = {
      ...r.tree,
      components: JSON.parse(JSON.stringify(r.tree.components)) as ComponentNode[],
    };
    const strip = (ns: ComponentNode[]): ComponentNode[] => ns
      .filter((n) => (n.type as string) !== 'protuberance')
      .map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
    without.components = strip(without.components);

    // The file's own Mach-Alt table (its rows are the harness's arcas machAlt).
    const opts = {
      machMin: 0.05, machMax: 5, machStep: 0.025, aoaDeg: 0,
      machAlt: r.machAlt ?? undefined,
    };
    const run = (t: typeof r.tree) => {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(t));
      return { info: rocket.staticInfo(), sweep: rocket.dragSweep(opts) };
    };
    const a = run(r.tree);
    const b = run(without);

    // Drag: exactly the override, at every Mach on the grid.
    for (let i = 0; i < a.sweep.machs.length; i++) {
      expect(a.sweep.powerOff.total[i]! - b.sweep.powerOff.total[i]!).toBeCloseTo(expected, 9);
      // …and it is ALL override: the three computed buckets do not move.
      expect(a.sweep.powerOff.friction[i]!).toBeCloseTo(b.sweep.powerOff.friction[i]!, 12);
      expect(a.sweep.powerOff.pressure[i]!).toBeCloseTo(b.sweep.powerOff.pressure[i]!, 12);
      expect(a.sweep.powerOff.base[i]!).toBeCloseTo(b.sweep.powerOff.base[i]!, 12);
    }
    // Statics: untouched, to the last bit.
    expect(a.info.mass).toBe(b.info.mass);
    expect(a.info.cg).toBe(b.info.cg);
    expect(a.info.cp).toBe(b.info.cp);
    expect(a.info.cna).toBe(b.info.cna);
    expect(a.info.refDiameter).toBe(b.info.refDiameter);
    expect(a.info.lengthAerodynamic).toBe(b.info.lengthAerodynamic);
    expect(a.info.warningTexts).toEqual(b.info.warningTexts);
  }, 120000);

  it('resolves a transition fore radius from the part in front, not its own <Diameter>', () => {
    // .CDX1 stores <Diameter> as a duplicate of <RearDiameter> on a transition;
    // the real front diameter is implicit. Taking it literally made every
    // mid-body transition a cylinder and stepped the airframe.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const parts = flatten(r.tree.components);
    const transitions = parts.filter((c) => c.type === 'transition' && c.name === 'Transition');
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    // 3" tube -> 2.5" tube, then 2.5" -> 3": both are real tapers, not cylinders.
    for (const t of transitions) {
      expect(t['foreRadius']).not.toBeCloseTo(t['aftRadius'] as number, 9);
    }
  });
});

describe('RASAero engine export (gated — see CDX1_ENGINE_EXPORT)', () => {
  // Single-stage with the mount tube id 'b'; the AeroTech J350W is a motor
  // RASAero II's own database definitely ships (the hand-off test file in
  // docs/User files/ uses the same one).
  const design = {
    name: 'EngineOut',
    tree: {
      name: 'EngineOut',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3048, aftRadius: 0.0381, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube' as const, id: 'b', length: 0.9144, outerRadius: 0.0381, thickness: 0.001,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 3, rootChord: 0.1524, tipChord: 0.0762, sweep: 0.0762, height: 0.0762, thickness: 0.0032, position: { method: 'bottom' as const, offset: 0 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.9144, deployEvent: 'apogee' },
              ],
            },
          ],
        },
      ],
    },
    launchMassKg: 2.72,
    launchCgM: 0.762,
    motors: { b: { designation: 'J350W', manufacturer: 'AeroTech' } },
  };

  it('is ON by default — proven against real RASAero II 2026-08-25', () => {
    // docs/User files/rasaero-engine-export-test.CDX1 opened cleanly in
    // RASAero II ("Motor: J350W  (AT)", Loaded Wt. 5.9966 lb) — screenshot
    // alongside it. The constant stays the one-line revert if a tester ever
    // hits the NullReferenceException on a motor RASAero's database lacks.
    expect(CDX1_ENGINE_EXPORT).toBe(true);
    const xml = exportCdx1(design);
    expect(xml).toContain('<SustainerEngine>J350W  (AT)</SustainerEngine>');
    expect(xml).toContain('<IncludeBooster1>False</IncludeBooster1>');
  });

  it('still writes no engine string when the caller opts out', () => {
    const xml = exportCdx1({ ...design, engineExport: false });
    expect(xml).not.toContain('Engine>');
  });

  it('writes the desktop engine string (two spaces) directly before SustainerLaunchWt', () => {
    const xml = exportCdx1({ ...design, engineExport: true });
    // RASAeroCommonConstants.OPENROCKET_TO_RASAERO_MOTOR parity:
    // 'DESIGNATION  (ABBREV)', exactly two spaces.
    expect(xml).toContain('<SustainerEngine>J350W  (AT)</SustainerEngine>\n<SustainerLaunchWt>');
    // A motorless single-stage sim still claims no boosters.
    expect(xml).toContain('<IncludeBooster1>False</IncludeBooster1>');
    expect(xml).toContain('<IncludeBooster2>False</IncludeBooster2>');
  });

  it('round-trips the engine through our own importer as a flight configuration', () => {
    const back = importCdx1(exportCdx1({ ...design, engineExport: true }));
    expect(back.configs.length).toBe(1);
    const motors = Object.values(back.configs[0]!.motors);
    expect(motors.length).toBe(1);
    expect(motors[0]!.designation).toBe('J350W');
    expect(motors[0]!.manufacturer).toBe('AT');
    expect(motors[0]!.delay).toBe(Infinity); // RASAero is apogee-deploy: plugged
  });

  it('omits (never guesses) engines whose manufacturer RASAero does not document', () => {
    const xml = exportCdx1({
      ...design,
      motors: { b: { designation: 'D9', manufacturer: 'Klima' } },
      engineExport: true,
    });
    // A name RASAero's database lacks is the NRE — the whole reason for the gate.
    expect(xml).not.toContain('Engine>');
    expect(xml).toContain('<SustainerLaunchWt>'); // block still complete
  });

  it('maps manufacturers to RASAero abbreviations (desktop RASAeroCommonConstants parity)', () => {
    expect(rasaeroManufacturerAbbrev('AeroTech')).toBe('AT'); // thrustcurve abbrev
    expect(rasaeroManufacturerAbbrev('AeroTech-RMS')).toBe('AT'); // .eng variant
    expect(rasaeroManufacturerAbbrev('Cesaroni')).toBe('CTI');
    expect(rasaeroManufacturerAbbrev('Cesaroni Technology Inc.')).toBe('CTI'); // .ork full name
    expect(rasaeroManufacturerAbbrev('Estes')).toBe('ES');
    expect(rasaeroManufacturerAbbrev('Loki')).toBe('LR');
    expect(rasaeroManufacturerAbbrev('R.A.T.T. Works')).toBe('RTW'); // punctuation-normalized
    expect(rasaeroManufacturerAbbrev('Klima')).toBeNull(); // not in RASAero's set
    expect(rasaeroManufacturerAbbrev('EX')).toBeNull();
    expect(rasaeroManufacturerAbbrev(undefined)).toBeNull();
  });

  it('writes a booster engine with IncludeBooster1 True and round-trips both motors', () => {
    const twoStage = {
      name: 'TwoUp',
      tree: {
        components: [
          {
            type: 'stage' as const, id: 's0', name: 'Sustainer',
            children: [
              { type: 'nosecone' as const, id: 'n', length: 0.25, aftRadius: 0.0381, thickness: 0.002, shape: 'ogive' },
              { type: 'bodytube' as const, id: 'b0', length: 0.7, outerRadius: 0.0381, thickness: 0.001 },
            ],
          },
          {
            type: 'stage' as const, id: 's1', name: 'Booster',
            children: [
              {
                type: 'bodytube' as const, id: 'b1', length: 0.5, outerRadius: 0.0381, thickness: 0.001,
                children: [
                  { type: 'trapezoidfinset' as const, id: 'f1', finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
                ],
              },
            ],
          },
        ],
      },
      motors: {
        b0: { designation: 'J350W', manufacturer: 'AeroTech' },
        b1: { designation: 'K550W', manufacturer: 'AeroTech' },
      },
      engineExport: true,
    };
    const xml = exportCdx1(twoStage);
    expect(xml).toContain('<Booster1Engine>K550W  (AT)</Booster1Engine>\n<Booster1LaunchWt>');
    expect(xml).toContain('<IncludeBooster1>True</IncludeBooster1>');
    expect(xml).toContain('<IncludeBooster2>False</IncludeBooster2>');
    const back = importCdx1(xml);
    expect(back.configs.length).toBe(1);
    const designations = Object.values(back.configs[0]!.motors).map((m) => m.designation).sort();
    expect(designations).toEqual(['J350W', 'K550W']);
  });

  it('puts the loaded mass/CG in the LAST stage cell, not the sustainer (cells are cumulative)', () => {
    // RASAero's per-stage cells are the vehicle from the nose down to that
    // stage: a RASAero-written two-stage file carries sustainer 4.06 lb / CG
    // 35.96 in against booster1 5.64 lb / CG 43.06 in
    // (__fixtures__/Complex.Two-Stage.CDX1). `design` supplies only the WHOLE
    // rocket's 2.72 kg / 0.762 m, which is Booster1's cell here and not the
    // sustainer's — the sustainer's own weight is unknown, and 0 is RASAero's
    // "not entered".
    const booster = {
      type: 'stage' as const, id: 's1', name: 'Booster',
      children: [
        {
          type: 'bodytube' as const, id: 'b1', length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: 'f1', finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    };
    const xml = exportCdx1({
      ...design,
      tree: { ...design.tree, components: [...design.tree.components, booster] },
      motors: { ...design.motors, b1: { designation: 'K550W', manufacturer: 'AeroTech' } },
      engineExport: true,
    });
    expect(xml).toContain('<SustainerLaunchWt>0</SustainerLaunchWt>');
    expect(xml).toContain('<SustainerCG>0</SustainerCG>');
    expect(xml).not.toContain('<SustainerLaunchWt>5.9966</SustainerLaunchWt>');
    expect(xml).toContain('<Booster1LaunchWt>5.9966</Booster1LaunchWt>'); // 2.72 kg → lb
    expect(xml).toContain('<Booster1CG>29.9999</Booster1CG>'); // 0.762 m → in
    expect(xml).toContain('<Booster2LaunchWt>0</Booster2LaunchWt>'); // no third stage
    // The booster is still claimed, with its engine — unchanged behaviour.
    expect(xml).toContain('<Booster1Engine>K550W  (AT)</Booster1Engine>');
    expect(xml).toContain('<IncludeBooster1>True</IncludeBooster1>');
  });

  it('a three-stage design fills BOOSTER 2, the only cell that means the whole stack', () => {
    // The stack size where the old and the new cell choice differ most, and
    // the one no test observed: the two-stage case asserts Booster2 is 0,
    // which a resolver capped at Booster1 would also produce. Mutating
    // `lastStage` to Math.min(stagesIn.length - 1, 1) passes the whole file
    // without this.
    const mkStage = (id: string, name: string) => ({
      type: 'stage' as const, id: `s_${id}`, name,
      children: [
        {
          type: 'bodytube' as const, id, length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: `f_${id}`, finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    });
    const xml = exportCdx1({
      ...design,
      tree: {
        ...design.tree,
        components: [...design.tree.components, mkStage('b1', 'Booster'), mkStage('b2', 'Booster 2')],
      },
      motors: {
        ...design.motors,
        b1: { designation: 'K550W', manufacturer: 'AeroTech' },
        b2: { designation: 'L850W', manufacturer: 'AeroTech' },
      },
      engineExport: true,
    });
    expect(xml).toContain('<SustainerLaunchWt>0</SustainerLaunchWt>');
    expect(xml).toContain('<Booster1LaunchWt>0</Booster1LaunchWt>');
    expect(xml).toContain('<Booster1CG>0</Booster1CG>');
    expect(xml).toContain('<Booster2LaunchWt>5.9966</Booster2LaunchWt>');
    expect(xml).toContain('<Booster2CG>29.9999</Booster2CG>');
    expect(xml).toContain('<IncludeBooster2>True</IncludeBooster2>');
  });

  it('keeps the single-stage sustainer cells (the RASAero-proven combination)', () => {
    const xml = exportCdx1({ ...design, engineExport: true });
    expect(xml).toContain('<SustainerLaunchWt>5.9966</SustainerLaunchWt>');
    expect(xml).toContain('<SustainerCG>29.9999</SustainerCG>');
    expect(xml).toContain('<Booster1LaunchWt>0</Booster1LaunchWt>');
    expect(xml).toContain('<Booster1CG>0</Booster1CG>');
  });
});
