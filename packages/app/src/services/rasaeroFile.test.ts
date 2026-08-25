// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';

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
    expect(joined).toMatch(/Protuberance/);
    expect(joined).toMatch(/BluntRadius/);
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
