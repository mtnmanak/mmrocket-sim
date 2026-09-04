// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportRkt, importRkt } from './rocksimFile.js';
import { loadPresets } from './presets.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Fixtures are the DESKTOP's own RockSim test files (24.12 source tree). */
function fixture(name: string): string {
  return readFileSync(join(here, '__fixtures__', name), 'utf8');
}

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

describe('RockSim import — desktop fixture files', () => {
  it('imports the minimal test rocket with desktop-equivalent values', () => {
    const r = importRkt(fixture('rocksimTestRocket1.rkt'));
    expect(r.name).toBe('FooBar Test');
    expect(r.tree.components.length).toBe(1); // single stage
    const chain = r.tree.components[0]!.children!;
    expect(chain[0]!.type).toBe('nosecone');
    // Len 396.875 mm → 0.396875 m; BaseDia 57.15 mm diameter → 0.028575 m radius.
    expect(chain[0]!['length']).toBeCloseTo(0.396875, 9);
    expect(chain[0]!['aftRadius']).toBeCloseTo(0.028575, 9);
    expect(chain[0]!['shape']).toBe('conical'); // ShapeCode 0
    expect(chain[0]!['filled']).toBeUndefined(); // ConstructionType 1 = hollow
    expect(chain[0]!['shoulderLength']).toBeCloseTo(0.0583997, 9);
    expect(chain[0]!['shoulderRadius']).toBeCloseTo(0.0531012 / 2, 9);

    // Skip the cone's synthesised base extension — it is a bodytube too, and it is
    // the FIRST one, sitting between the cone and the real airframe.
    const body = chain.find((c) => c.type === 'bodytube' && c['rktBaseExtension'] !== true)!;
    expect(body['outerRadius']).toBeCloseTo(0.06604 / 2, 9);
    // Wall from OD/ID: (66.04 - 65.786)/2 mm.
    expect(body['thickness']).toBeCloseTo(0.000127, 9);

    expect(chain.some((c) => c.type === 'transition')).toBe(true);
    const all = flatten(r.tree.components);
    expect(all.some((c) => c.type === 'trapezoidfinset')).toBe(true);
  });

  it('imports the motor the desktop drops (EngineSet → mount by serial)', () => {
    const r = importRkt(fixture('rocksimTestRocket1.rkt'));
    const refs = Object.values(r.motors);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]!.designation).toBe('E6');
    const mount = flatten(r.tree.components).find((c) => c.id === refs[0]!.mountId)!;
    expect(mount['motorMount']).toBe(true);
  });

  it('imports all three stages of the everything rocket', () => {
    const r = importRkt(fixture('rocksimTestRocket2.rkt'));
    expect(r.tree.components.length).toBe(3);
    expect(r.tree.components.map((s) => s.name)).toEqual(['Sustainer', 'Booster', 'Booster 2']);
    const all = flatten(r.tree.components);
    // Ring usage codes fan out (fixture carries 0=centering ×7, 3=sleeve→
    // centering, 2=engine block, 4=coupler; no bulkhead in this file).
    expect(all.filter((c) => c.type === 'centeringring').length).toBe(8);
    expect(all.some((c) => c.type === 'engineblock')).toBe(true);
    expect(all.some((c) => c.type === 'tubecoupler')).toBe(true);
    expect(all.some((c) => c.type === 'parachute')).toBe(true);
    expect(all.some((c) => c.type === 'freeformfinset')).toBe(true);
    expect(all.some((c) => c.type === 'masscomponent' || c.type === 'shockcord')).toBe(true);
  });

  it('parses freeform PointList in mm with RockSim point order', () => {
    const r = importRkt(fixture('FinsOnTransitions.rkt'));
    // Selected by name, not by type: BOTH of this fixture's fin sets sit on
    // transitions, and the importer now converts the trapezoid one ("Fin set 1")
    // to a freeform outline too, so a plain find(type === 'freeformfinset')
    // picks that synthesized set instead. "Fin set 2" is the one that carries
    // the real <PointList>, which is what this test is about.
    const ff = flatten(r.tree.components).find(
      (c) => c.type === 'freeformfinset' && c.name === 'Fin set 2',
    )!;
    const pts = ff['points'] as [number, number][];
    // File: 60,0|50,30|25,35|0,0| → reversed (last point is 0,0) and ÷1000.
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]![0]).toBeCloseTo(0.06, 9);
    expect(pts.some(([, y]) => Math.abs(y - 0.035) < 1e-9)).toBe(true);
  });

  it('fins on a transition build in the kernel (converted to freeform)', async () => {
    // The regression this pins: RockSim puts a trapezoid FinSet inside a
    // Transition's AttachedParts, and the kernel refuses any non-freeform fin
    // set there — buildTree threw "TrapezoidFinSet not currently compatible
    // with Transition" and the imported design lost mass, CG, CP and Simulate.
    // Parsing alone was green, which is why it shipped: this asserts the BUILD.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const r = importRkt(fixture('FinsOnTransitions.rkt'));
    const finsOnTransition = flatten(r.tree.components).filter((c) => c.type === 'freeformfinset');
    expect(finsOnTransition.length).toBeGreaterThan(0);

    const built = OrkRocket.buildTree(engineTree(r.tree));
    const info = built.staticInfo();
    expect(Number.isFinite(info.mass)).toBe(true);
    expect(info.mass).toBeGreaterThan(0);
    expect(Number.isFinite(info.cp)).toBe(true);
  }, 60000);

  it("converts a chute's RockSim bulk density to a surface density that matches its CalcMass", () => {
    // RockSim stores a canopy as BULK density + Thickness; this app and the
    // kernel want kg/m². Without the conversion (the desktop does it in
    // RecoveryDeviceHandler.computeDensity) the chute silently fell back to the
    // built-in ripstop default and was billed at 19.55 g — 2.9x the truth, and
    // the error grows with canopy area.
    const r = importRkt(fixture('TubeFins2.rkt'));
    const chute = flatten(r.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['surfaceDensity']).toBeDefined();
    expect(chute['surfaceMaterialName']).toBe('Polyethylene LDPE');
    // The file's own <CalcMass> is 6.87 g.
    const area = Math.PI * ((chute['diameter'] as number) / 2) ** 2;
    const massG = (chute['surfaceDensity'] as number) * area * 1000;
    expect(massG).toBeGreaterThan(6.5);
    expect(massG).toBeLessThan(7.2);
    // The dead bulk density must not linger on a recovery device.
    expect(chute['density']).toBeUndefined();
  });

  it('round-trips a chute and shock cord with their real mass, not Density 0', () => {
    // common() emitted one bulk <Density> for everything, but soft goods carry
    // surfaceDensity / lineDensity — so every exported chute, streamer and
    // shock cord landed in RockSim weighing nothing.
    const r = importRkt(fixture('TubeFins2.rkt'));
    const xml = exportRkt({ name: 'RT', tree: r.tree });
    const chuteBlock = xml.split('<Parachute>')[1]!.split('</Parachute>')[0]!;
    expect(chuteBlock).toContain('<DensityType>1</DensityType>');
    const density = Number(/<Density>([^<]*)<\/Density>/.exec(chuteBlock)![1]);
    expect(density).toBeGreaterThan(0);

    // ...and it survives a full round trip back into the app.
    const back = importRkt(xml);
    const chute = flatten(back.tree.components).find((c) => c.type === 'parachute')!;
    const orig = flatten(r.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['surfaceDensity']).toBeCloseTo(orig['surfaceDensity'] as number, 9);
  });

  it('imports tube fins and the C6 motor of TubeFins2', () => {
    const r = importRkt(fixture('TubeFins2.rkt'));
    const all = flatten(r.tree.components);
    const tf = all.find((c) => c.type === 'tubefinset')!;
    expect(tf['finCount']).toBeGreaterThan(0);
    expect(Object.values(r.motors)[0]?.designation).toBe('C6');
  });
});

describe('RockSim export → import round trip', () => {
  const staged = {
    name: 'RT',
    tree: {
      name: 'RT',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.12, aftRadius: 0.025, thickness: 0.002, shape: 'ogive', shoulderLength: 0.03, shoulderRadius: 0.024 },
            {
              type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.025, thickness: 0.001, density: 950,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 4, rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05, thickness: 0.003, crossSection: 'airfoil', tabHeight: 0.01, tabLength: 0.04, position: { method: 'bottom' as const, offset: 0 } },
                { type: 'innertube' as const, id: 'm', length: 0.075, outerRadius: 0.0145, thickness: 0.0005, motorMount: true, position: { method: 'bottom' as const, offset: -0.01 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.45, lineCount: 8, lineLength: 0.5 },
              ],
            },
          ],
        },
        {
          type: 'stage' as const, id: 's1', name: 'Booster',
          children: [
            {
              type: 'bodytube' as const, id: 'b2', length: 0.15, outerRadius: 0.025, thickness: 0.001,
              children: [
                { type: 'innertube' as const, id: 'm2', length: 0.075, outerRadius: 0.0145, thickness: 0.0005, motorMount: true },
              ],
            },
          ],
        },
      ],
    },
    motors: {
      m: { designation: 'F39', manufacturer: 'AeroTech', diameter: 0.029, length: 0.124, delay: 6 },
      m2: { designation: 'F39', manufacturer: 'AeroTech', diameter: 0.029, length: 0.124, delay: 0 },
    },
  };

  it('round-trips geometry, stages, and motors', () => {
    const xml = exportRkt(staged);
    const back = importRkt(xml);

    expect(back.tree.components.length).toBe(2);
    const chain = back.tree.components[0]!.children!;
    expect(chain[0]!['length']).toBeCloseTo(0.12, 9);
    expect(chain[0]!['aftRadius']).toBeCloseTo(0.025, 9);
    expect(chain[0]!['shoulderRadius']).toBeCloseTo(0.024, 9);

    const body = chain[1]!;
    expect(body['outerRadius']).toBeCloseTo(0.025, 9);
    expect(body['thickness']).toBeCloseTo(0.001, 9);

    const fins = body.children!.find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['crossSection']).toBe('airfoil');
    expect(fins['tabHeight']).toBeCloseTo(0.01, 9);
    // Bottom-referenced position survives the double sign flip.
    const mount = body.children!.find((c) => c.type === 'innertube')!;
    expect(mount.position?.method).toBe('bottom');
    expect(mount.position?.offset).toBeCloseTo(-0.01, 9);
    expect(mount['motorMount']).toBe(true);

    // Motors come back attached to their mounts (better than the desktop).
    const refs = Object.values(back.motors);
    expect(refs.length).toBe(2);
    expect(refs.every((m) => m.designation === 'F39')).toBe(true);
    const delays = refs.map((m) => m.delay).sort();
    expect(delays).toEqual([0, 6]);
  });

  it('splits a clustered mount into individual tubes (RockSim has no clusters)', () => {
    const clustered = {
      name: 'C', tree: {
        components: [
          {
            type: 'stage' as const, id: 's', name: 'Sustainer',
            children: [{
              type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.033, thickness: 0.001,
              children: [{
                type: 'innertube' as const, id: 'm', length: 0.07, outerRadius: 0.0095,
                thickness: 0.0005, motorMount: true, cluster: '3-ring',
              }],
            }],
          },
        ],
      },
    };
    const xml = exportRkt(clustered);
    expect((xml.match(/<IsInsideTube>1<\/IsInsideTube>/g) ?? []).length).toBe(3);
    // Import reconstructs the fanned-out tubes into ONE tagged cluster
    // (issue 2026-08-05a #16: they used to come back as 3 separate tubes).
    const back = importRkt(xml);
    const tubes = flatten(back.tree.components).filter((c) => c.type === 'innertube');
    expect(tubes.length).toBe(1);
    expect(tubes[0]!['cluster']).toBe('3-ring');
    expect(tubes[0]!['clusterScale']).toBeCloseTo(1, 3);
    expect(back.notes.join(' ')).toMatch(/cluster/i);
  });

  it('reconstructs a real-world ring despite RockSim rounding drift (Darkstar case)', () => {
    // the owner's 12in Darkstar: 6×75mm ring (RadialLoc 95.25 mm, exact 60° steps
    // in radians) around a central 98mm mount — but RockSim wrote tube 1's
    // OD as 79.38 and tubes 2–6 as 79.375, which defeated exact-key grouping.
    const tube = (name: string, od: number, angle: number) => `
      <BodyTube><Name>${name}</Name><IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount>
        <OD>${od}</OD><ID>${od - 2}</ID><Len>1219.2</Len><Xb>0.</Xb>
        <RadialLoc>95.25</RadialLoc><RadialAngle>${angle}</RadialAngle>
      </BodyTube>`;
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Darkstar-ish</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Booster</Name><OD>310</OD><ID>305</ID><Len>1390.65</Len>
          <AttachedParts>
            <BodyTube><Name>central 98</Name><IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount>
              <OD>102.</OD><ID>98</ID><Len>1390.65</Len><Xb>0.</Xb>
              <RadialLoc>0.</RadialLoc><RadialAngle>0.</RadialAngle>
            </BodyTube>
            ${tube('cluster motor tube 1', 79.38, 0)}
            ${tube('cluster motor tube 2', 79.375, 1.0472)}
            ${tube('cluster motor tube 3', 79.375, 2.0944)}
            ${tube('cluster motor tube 4', 79.375, 3.14159)}
            ${tube('cluster motor tube 5', 79.375, -2.0944)}
            ${tube('cluster motor tube 6', 79.375, -1.0472)}
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketSimDocument-typo-guard></RocketDesign></DesignInformation></RockSimDocument>`
      .replace('</RocketSimDocument-typo-guard>', '');
    const r = importRkt(xml);
    const tubes = flatten(r.tree.components).filter((c) => c.type === 'innertube');
    expect(tubes.length).toBe(2); // central + ONE reconstructed 6-ring
    const ring = tubes.find((t) => t['cluster'] === '6-ring')!;
    expect(ring).toBeDefined();
    // separation = 2·r·scale; circumradius (=separation for 6-ring) = 95.25mm.
    expect((ring['clusterScale'] as number) * 2 * (ring['outerRadius'] as number)).toBeCloseTo(0.09525, 4);
    const central = tubes.find((t) => t !== ring)!;
    expect(central['cluster']).toBeUndefined();
    expect(central['outerRadius']).toBeCloseTo(0.051, 9);
  });

  it('de-collides overlapping fin sets at the same angle (Ultra Neon case)', () => {
    // Tube fins + straight fins on one tube, both at RadialAngle 0 (what
    // RockSim actually writes) — physically impossible; the straight set
    // must come in rotated by half the tube-fin pitch (6 tubes → 30°).
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>UN</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Booster</Name><OD>102</OD><ID>98</ID><Len>800</Len>
          <AttachedParts>
            <TubeFinSet><Name>Tube fins</Name><TubeCount>6</TubeCount><OD>50</OD><ID>48</ID><Len>150</Len>
              <Xb>0.</Xb><LocationMode>2</LocationMode><RadialAngle>0.</RadialAngle></TubeFinSet>
            <FinSet><Name>Straight Fin set</Name><ShapeCode>0</ShapeCode><FinCount>3</FinCount>
              <RootChord>150</RootChord><TipChord>75</TipChord><SweepDistance>50</SweepDistance>
              <SemiSpan>80</SemiSpan><Thickness>4</Thickness>
              <Xb>0.</Xb><LocationMode>2</LocationMode><RadialAngle>0.</RadialAngle></FinSet>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const r = importRkt(xml);
    const all = flatten(r.tree.components);
    const tubeFins = all.find((c) => c.type === 'tubefinset')!;
    const straight = all.find((c) => c.type === 'trapezoidfinset')!;
    expect(tubeFins['rotation']).toBeUndefined(); // first set keeps its angle
    expect(straight['rotation']).toBeCloseTo(Math.PI / 6, 9); // +30° interleave
    expect(r.notes.join(' ')).toMatch(/rotated 30/);
  });

  it('reconstructs a rotated, spaced cluster with its scale and rotation', () => {
    const clustered = {
      name: 'C2', tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.05, thickness: 0.001,
            children: [{
              type: 'innertube' as const, id: 'm', length: 0.07, outerRadius: 0.012,
              thickness: 0.0005, motorMount: true, cluster: '4-ring',
              clusterScale: 1.25, clusterRotation: Math.PI / 6,
            }],
          }],
        }],
      },
    };
    const back = importRkt(exportRkt(clustered));
    const tube = flatten(back.tree.components).find((c) => c.type === 'innertube')!;
    expect(tube['cluster']).toBe('4-ring');
    expect(tube['clusterScale']).toBeCloseTo(1.25, 3);
    // 4-ring has 90° symmetry — any equivalent rotation is fine.
    const rot = ((tube['clusterRotation'] as number | undefined) ?? 0) % (Math.PI / 2);
    const want = (Math.PI / 6) % (Math.PI / 2);
    expect(Math.min(Math.abs(rot - want), Math.abs(Math.abs(rot - want) - Math.PI / 2))).toBeLessThan(0.01);
  });

  it('exports the OVERRIDE mass of a mass component, not the param default', () => {
    const design = {
      name: 'OV',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            children: [{
              // mass param at the 10 g default, override set to 250 g — the
              // override is the real mass (issue 2026-08-05a #11).
              type: 'masscomponent' as const, id: 'w', mass: 0.01, overrideMass: 0.25, length: 0.03,
            }],
          }],
        }],
      },
    };
    const xml = exportRkt(design);
    expect(xml).toMatch(/<KnownMass>250<\/KnownMass>/);
    expect(xml).not.toMatch(/<KnownMass>10<\/KnownMass>/);
  });

  it('MotorDia for a sub-minimum mount is the OUTER diameter, not the bore', () => {
    // A caseAirframe body tube is the minimum-diameter case: the motor case IS
    // the airframe, so the fit reference is the tube's OD. The exporter used to
    // hand-roll `or − thickness` here — the one site still doing its own
    // version of the arithmetic `mountBore` owns — and shipped a 29 mm mount as
    // 28 mm, understating the very motor the rocket is built around.
    const design = (caseAirframe: boolean) => ({
      name: 'MD',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3,
            outerRadius: 0.0145, thickness: 0.0005,
            motorMount: true, caseAirframe,
          }],
        }],
      },
    });
    // 14.5 mm radius -> 29 mm OD. RockSim stores diameters in mm.
    expect(exportRkt(design(true))).toMatch(/<MotorDia>29<\/MotorDia>/);
    // Without the flag it is a normal mount and the bore is the reference:
    // (14.5 − 0.5) x 2 = 28 mm.
    expect(exportRkt(design(false))).toMatch(/<MotorDia>28<\/MotorDia>/);
  });

  it('partial overrides export the computed other value', () => {
    const design = {
      name: 'PO',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            // Mass override only — the CG must come from compInfo, not 0.
            overrideMass: 0.123,
          }],
        }],
      },
      compInfo: { b: { mass: 0.05, cgX: 0.15 } },
    };
    const xml = exportRkt(design);
    expect(xml).toMatch(/<KnownMass>123<\/KnownMass>/);
    expect(xml).toMatch(/<KnownCG>150<\/KnownCG>/);
    // <KnownCG> still has to be a real number — a 0 there pins the CG to the
    // component's front in any reader that couples the flags. The flag stays
    // 1 (issue 2026-08-23a): splitting it would state our intent more exactly
    // but makes RockSim and desktop OpenRocket discard the measured mass, and
    // a 1 costs nothing — the CG they then apply is the one they would have
    // computed anyway.
    expect(xml).toMatch(/<UseKnownCG>1<\/UseKnownCG>/);
    expect(xml).not.toMatch(/<UseKnownMass>/);
  });

  it('round-trips pods as ExternalPods (split instances, radians, FREE radius)', () => {
    const design = {
      name: 'POD',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.03, thickness: 0.001,
            children: [{
              type: 'podset' as const, id: 'p', instanceCount: 2,
              radiusMethod: 'free', radiusOffset: 0.05, angleOffset: Math.PI / 4,
              position: { method: 'bottom' as const, offset: 0 },
              children: [{
                type: 'bodytube' as const, id: 'pb', length: 0.15, outerRadius: 0.012, thickness: 0.0005,
              }],
            }],
          }],
        }],
      },
    };
    const xml = exportRkt(design);
    expect((xml.match(/<ExternalPod>/g) ?? []).length).toBe(2); // instances split
    expect(xml).toMatch(/<Detachable>0<\/Detachable>/);
    const back = importRkt(xml);
    const pods = flatten(back.tree.components).filter((c) => c.type === 'podset');
    expect(pods.length).toBe(2); // RockSim is single-instance — 2 pods of 1
    expect(pods[0]!['radiusMethod']).toBe('free');
    expect(pods[0]!['radiusOffset']).toBeCloseTo(0.05, 9);
    expect(pods[0]!['angleOffset']).toBeCloseTo(Math.PI / 4, 9);
    expect(pods[1]!['angleOffset']).toBeCloseTo(Math.PI / 4 + Math.PI, 9);
    expect(pods[0]!.children?.[0]?.type).toBe('bodytube');
    expect(pods[0]!.children?.[0]?.['outerRadius']).toBeCloseTo(0.012, 9);
  });

  it('round-trips fin cant angle (radians, desktop exporter convention)', () => {
    const design = {
      name: 'CANT',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            children: [{
              type: 'trapezoidfinset' as const, id: 'f', finCount: 3, rootChord: 0.05,
              tipChord: 0.02, sweep: 0.02, height: 0.04, thickness: 0.003, cant: 0.0524,
            }],
          }],
        }],
      },
    };
    const back = importRkt(exportRkt(design));
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['cant']).toBeCloseTo(0.0524, 9);
  });

  it('round-trips tube fin wall thickness (OD/ID)', () => {
    const design = {
      name: 'TF',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            children: [{
              type: 'tubefinset' as const, id: 't', finCount: 6, length: 0.1,
              outerRadius: 0.0093, thickness: 0.0004,
            }],
          }],
        }],
      },
    };
    const back = importRkt(exportRkt(design));
    const tf = flatten(back.tree.components).find((c) => c.type === 'tubefinset')!;
    expect(tf['outerRadius']).toBeCloseTo(0.0093, 9);
    expect(tf['thickness']).toBeCloseTo(0.0004, 9);
  });

  it('round-trips a mass component (KnownMass must be emitted once)', () => {
    const design = {
      name: 'M',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            children: [{ type: 'masscomponent' as const, id: 'w', mass: 0.05, length: 0.03 }],
          }],
        }],
      },
    };
    const xml = exportRkt(design);
    const back = importRkt(xml);
    const mass = flatten(back.tree.components).find((c) => c.type === 'masscomponent')!;
    expect(mass['mass']).toBeCloseTo(0.05, 9);
  });

  it('flattens sub-assemblies nested inside attached parts (not just stage level)', () => {
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>SA</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          <AttachedParts>
            <SubAssembly><Name>Bay</Name>
              <AttachedParts>
                <MassObject><Name>Weight</Name><TypeCode>0</TypeCode><KnownMass>20</KnownMass><Len>20</Len></MassObject>
              </AttachedParts>
            </SubAssembly>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const r = importRkt(xml);
    const mass = flatten(r.tree.components).find((c) => c.type === 'masscomponent')!;
    expect(mass['mass']).toBeCloseTo(0.02, 9);
    expect(r.notes.join(' ')).toMatch(/flattened/);
  });

  it('keeps a streamer with RockSim’s default 0.75 cd on auto', () => {
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>ST</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          <AttachedParts>
            <Streamer><Name>Str</Name><Len>500</Len><Width>50</Width><DragCoefficient>0.75</DragCoefficient></Streamer>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const r = importRkt(xml);
    const streamer = flatten(r.tree.components).find((c) => c.type === 'streamer')!;
    expect(streamer['cd']).toBeUndefined();
  });

  it('rejects more than 3 stages (RockSim limit)', () => {
    const four = {
      name: 'X',
      tree: {
        components: [0, 1, 2, 3].map((i) => ({
          type: 'stage' as const, id: `st${i}`, name: `S${i}`,
          children: [{ type: 'bodytube' as const, length: 0.1, outerRadius: 0.012 }],
        })),
      },
    };
    expect(() => exportRkt(four)).toThrow(/at most 3 stages/);
  });

  it('converts middle positions to front-referenced Xb (RockSim has no middle mode)', () => {
    const d = {
      name: 'Mid',
      tree: {
        name: 'Mid',
        components: [{
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, length: 0.1, aftRadius: 0.0125, thickness: 0.002 },
            {
              type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.0125, thickness: 0.001,
              children: [
                { type: 'launchlug' as const, id: 'lug', length: 0.05, outerRadius: 0.0025, thickness: 0.0004, position: { method: 'middle' as const, offset: 0 } },
              ],
            },
          ],
        }],
      },
    };
    const xml = exportRkt(d);
    // Desktop BasePartDTO parity: xb = 0 + (0.4 - 0.05)/2 = 0.175 m = 175 mm.
    expect(xml).toMatch(/<Xb>175(\.0+\d?)?<\/Xb>/);
    const back = importRkt(xml);
    const lug = back.tree.components[0]!.children!
      .flatMap((c) => c.children ?? []).find((c) => c.type === 'launchlug')!;
    // Physical location preserved (comes back front-referenced).
    expect(lug.position?.method).toBe('top');
    expect(lug.position?.offset).toBeCloseTo(0.175, 9);
  });
});

/**
 * UseKnownMass and UseKnownCG are read INDEPENDENTLY (issue 2026-08-23a): a
 * weighed part keeps its weight even if its balance point was never measured,
 * and vice versa. Desktop OpenRocket couples them and throws both away unless
 * UseKnownCG is 1 — these tests pin the divergence, including the roll-up note
 * that tells the user about it.
 */
describe('RockSim measured mass and CG are independent', () => {
  /** A one-tube design whose BodyTube carries the given override fields. */
  const design = (fields: string) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>KM</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          ${fields}
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  const read = (fields: string) => {
    const r = importRkt(design(fields));
    return {
      tube: flatten(r.tree.components).find((c) => c.type === 'bodytube')!,
      notes: r.notes.join(' '),
    };
  };
  const VALUES = '<KnownMass>120</KnownMass><KnownCG>150</KnownCG>';

  it('applies a measured mass with no measured CG', () => {
    const { tube } = read(`${VALUES}<UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG>`);
    expect(tube['overrideMass']).toBeCloseTo(0.12, 9);
    expect(tube['overrideCGX']).toBeUndefined();
  });

  it('applies a measured CG with no measured mass', () => {
    const { tube } = read(`${VALUES}<UseKnownMass>0</UseKnownMass><UseKnownCG>1</UseKnownCG>`);
    expect(tube['overrideCGX']).toBeCloseTo(0.15, 9);
    expect(tube['overrideMass']).toBeUndefined();
  });

  it('applies both when both flags are set', () => {
    const { tube } = read(`${VALUES}<UseKnownMass>1</UseKnownMass><UseKnownCG>1</UseKnownCG>`);
    expect(tube['overrideMass']).toBeCloseTo(0.12, 9);
    expect(tube['overrideCGX']).toBeCloseTo(0.15, 9);
  });

  it('applies neither when neither flag is set', () => {
    const { tube } = read(`${VALUES}<UseKnownMass>0</UseKnownMass><UseKnownCG>0</UseKnownCG>`);
    expect(tube['overrideMass']).toBeUndefined();
    expect(tube['overrideCGX']).toBeUndefined();
  });

  it('still reads RockSim’s own dialect, where UseKnownCG=1 means both', () => {
    // <UseKnownMass> is a DESIGN-level element in real RockSim files (939-file
    // survey, 2026-08-23: at most one per file, never inside a part). With no
    // part-level flag to read, UseKnownCG=1 has to keep meaning both — reading
    // it as CG-only would discard 5,626 measured masses in that survey.
    const { tube } = read(`${VALUES}<UseKnownCG>1</UseKnownCG>`);
    expect(tube['overrideMass']).toBeCloseTo(0.12, 9);
    expect(tube['overrideCGX']).toBeCloseTo(0.15, 9);
  });

  it('does NOT believe a value whose flag is off, however tempting', () => {
    // 201 parts in the survey state a mass their own <CalcMass> contradicts
    // and look genuinely weighed; 303 hold a stale copy of the computed number
    // that must not become an override, and nothing in the file separates the
    // two with certainty. Pinning a mass nobody measured moves apogee with
    // nothing on screen to explain it, so we leave these alone until the owner
    // rules on it. This test exists to make that a DECISION, not an accident.
    const weighed = read('<KnownMass>120</KnownMass><CalcMass>95</CalcMass><UseKnownCG>0</UseKnownCG>');
    expect(weighed.tube['overrideMass']).toBeUndefined();
    const copied = read('<KnownMass>120</KnownMass><CalcMass>120</CalcMass><UseKnownCG>0</UseKnownCG>');
    expect(copied.tube['overrideMass']).toBeUndefined();
  });

  it('says so once when it keeps a value desktop OpenRocket would discard', () => {
    const massOnly = read(`${VALUES}<UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG>`);
    expect(massOnly.notes).toMatch(/desktop OpenRocket/i);
    expect(massOnly.notes).toMatch(/\b1 part\b/);
    expect(read(`${VALUES}<UseKnownMass>1</UseKnownMass><UseKnownCG>1</UseKnownCG>`).notes)
      .not.toMatch(/desktop OpenRocket/i);
    expect(read(`${VALUES}<UseKnownMass>0</UseKnownMass><UseKnownCG>0</UseKnownCG>`).notes)
      .not.toMatch(/desktop OpenRocket/i);
  });

  it('counts the affected parts once for the whole file, not once each', () => {
    const two = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>KM2</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>A</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          <KnownMass>120</KnownMass><UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG>
        </BodyTube>
        <BodyTube><Name>B</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          <KnownMass>90</KnownMass><UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const notes = importRkt(two).notes.filter((n) => /desktop OpenRocket/i.test(n));
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/\b2 parts\b/);
  });
});

describe('RockSim export → import round trip of the two override flags', () => {
  const rt = (over: Record<string, number>) => {
    const d = {
      name: 'RT',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            ...over,
          }],
        }],
      },
      // What App.tsx supplies for a partial override: the computed other half.
      compInfo: { b: { mass: 0.05, cgX: 0.15 } },
    };
    const xml = exportRkt(d);
    const back = importRkt(xml);
    return { xml, tube: flatten(back.tree.components).find((c) => c.type === 'bodytube')! };
  };

  it('carries a mass override across, with a CG equal to the computed one', () => {
    // Export deliberately keeps RockSim's coupled flag, so the measured mass
    // survives in RockSim and desktop OpenRocket. The price is that the
    // computed CG comes back as an explicit override — numerically the value
    // the geometry produces anyway, so nothing about the rocket changes.
    const { xml, tube } = rt({ overrideMass: 0.123 });
    expect(xml).toMatch(/<UseKnownCG>1<\/UseKnownCG>/);
    expect(xml).not.toMatch(/<UseKnownMass>/);
    expect(tube['overrideMass']).toBeCloseTo(0.123, 9);
    expect(tube['overrideCGX']).toBeCloseTo(0.15, 9);
  });

  it('carries a CG override across, with the computed mass alongside', () => {
    const { xml, tube } = rt({ overrideCGX: 0.2 });
    expect(xml).toMatch(/<UseKnownCG>1<\/UseKnownCG>/);
    expect(tube['overrideCGX']).toBeCloseTo(0.2, 9);
    expect(tube['overrideMass']).toBeCloseTo(0.05, 9);
  });

  it('round-trips both overrides together', () => {
    const { tube } = rt({ overrideMass: 0.123, overrideCGX: 0.2 });
    expect(tube['overrideMass']).toBeCloseTo(0.123, 9);
    expect(tube['overrideCGX']).toBeCloseTo(0.2, 9);
  });

  it('round-trips no override at all', () => {
    const { tube } = rt({});
    expect(tube['overrideMass']).toBeUndefined();
    expect(tube['overrideCGX']).toBeUndefined();
  });

  it('never warns about its own files — nothing we write loses data elsewhere', () => {
    // The divergence note is for files OTHER writers produce (a part-level
    // UseKnownMass=1 beside UseKnownCG=0). Because our export keeps the
    // coupled flag, none of our own files can be in that state.
    const cases: Record<string, number>[] = [{ overrideMass: 0.123 }, { overrideCGX: 0.2 },
      { overrideMass: 0.123, overrideCGX: 0.2 }, {}];
    for (const over of cases) {
      expect(importRkt(rt(over).xml).notes.join(' ')).not.toMatch(/desktop OpenRocket/i);
    }
  });
});

/**
 * Old RockSim (pre-9) wrote a BINARY design file that still carries a .rkt/.RKT
 * name. A 939-file survey of real vendor designs (2026-08-22) found 96 of them —
 * every Public Missiles kit in the set. They used to fail with "XML parse
 * error", which reads as "your file is corrupt" and leaves the user nowhere.
 */
describe('binary (pre-9) RockSim files', () => {
  const binary = () => {
    const head = '[[RS001024RS]]';
    const bytes = new Uint8Array(256);
    for (let i = 0; i < head.length; i += 1) bytes[i] = head.charCodeAt(i);
    for (let i = head.length; i < bytes.length; i += 1) bytes[i] = (i * 37) % 256;
    return bytes.buffer;
  };

  it('names the format and says what to do instead', () => {
    expect(() => importRkt(binary())).toThrow(/older BINARY RockSim file/);
    expect(() => importRkt(binary())).toThrow(/re-save|\.ork/);
  });

  it('does not mistake a real XML .rkt for one', () => {
    expect(() => importRkt(binary())).toThrow();
    // The fixtures elsewhere in this file import cleanly; the guard only fires
    // on the binary signature, never on well-formed XML.
    expect(() => importRkt('<RockSimDocument><DesignInformation><RocketDesign>'
      + '<Name>x</Name><Stage1Parts></Stage1Parts></RocketDesign></DesignInformation>'
      + '</RockSimDocument>')).not.toThrow(/older BINARY/);
  });
});

/**
 * The design-level stage mass/CG override (issues-2026-08-23b #1).
 *
 * RockSim states a whole-rocket weighed mass and balance point on
 * <RocketDesign>, NOT on a part — 67 files of the owner's 841-file readable
 * corpus carry one, and we used to drop every one of them. 57 of the 67 are an
 * exact whole gram or tenth-ounce and 52 of 63 CGs an exact tenth-inch, so they
 * are typed by a person; the stated mass runs a median 1.03x the summed part
 * masses, which is what glue, paint and hardware weigh.
 *
 * Two deliberate divergences from desktop OpenRocket, both ruled on by the
 * owner:
 *
 *  1. WE GATE ON <UseKnownMass>. Desktop reads only `stage3Mass > 0`
 *     (RockSimHandler.java:221) and never consults the flag — which its own
 *     exporter sets correctly (StageDTO.java:46-49), so its reader and writer
 *     disagree. 19 corpus files carry a stale non-zero mass with the flag off,
 *     and they are template leftovers: mcr_hawk_mim23a.rkt states 28.3495 g
 *     (exactly 1 oz) for a rocket whose own parts sum to ~678 g.
 *
 *  2. WE DO NOT PIN THE STAGE. Desktop applies it as a stage override with
 *     subcomponents ON, which makes every per-part mass stop contributing and
 *     leaves the rocket carrying the wrong rotational inertia. We hand the pair
 *     to the "Measured mass & CG" box instead, so the user sees the
 *     discrepancy and chooses.
 */
describe('RockSim design-level stage mass & CG', () => {
  const design = (fields: string, stageCount = 1) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>SM</Name><StageCount>${stageCount}</StageCount>
      ${fields}
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>24</OD><ID>22</ID></BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;

  const read = (fields: string, stageCount = 1) => {
    const r = importRkt(design(fields, stageCount));
    return { measured: r.measured, notes: r.notes.join(' ') };
  };

  const FLAGGED = '<UseKnownMass>1</UseKnownMass><Stage3Mass>292</Stage3Mass><Stage3CG>527.05</Stage3CG>';

  it('reads the stated mass and balance point into the measured pair, in SI', () => {
    const { measured } = read(FLAGGED);
    expect(measured?.massKg).toBeCloseTo(0.292, 12); // g -> kg
    expect(measured?.cgM).toBeCloseTo(0.52705, 12); // mm -> m
  });

  it('says what it found, and that nothing was applied yet', () => {
    const { notes } = read(FLAGGED);
    expect(notes).toMatch(/292/);
    expect(notes).toMatch(/Measured mass/i);
  });

  it('IGNORES a stated mass whose UseKnownMass flag is off', () => {
    // The 19-file failure mode. mcr_hawk_mim23a.rkt's real values.
    const { measured, notes } = read(
      '<UseKnownMass>0</UseKnownMass><Stage3Mass>28.3495</Stage3Mass><Stage3CG>500</Stage3CG>');
    expect(measured).toBeUndefined();
    expect(notes).not.toMatch(/Measured mass/i);
  });

  it('ignores it when the flag is absent entirely', () => {
    expect(read('<Stage3Mass>292</Stage3Mass><Stage3CG>527.05</Stage3CG>').measured).toBeUndefined();
  });

  it('takes a mass with no balance point — 4 corpus files are like that', () => {
    const { measured } = read('<UseKnownMass>1</UseKnownMass><Stage3Mass>283.495</Stage3Mass><Stage3CG>0</Stage3CG>');
    expect(measured?.massKg).toBeCloseTo(0.283495, 12);
    expect(measured?.cgM).toBeNull();
  });

  it('reports nothing when the flag is on but no value was stated', () => {
    expect(read('<UseKnownMass>1</UseKnownMass><Stage3Mass>0</Stage3Mass><Stage3CG>0</Stage3CG>')
      .measured).toBeUndefined();
  });

  it('does not fill the box for a multi-stage rocket, but does say so', () => {
    // A per-stage weight has no single meaning in a whole-rocket box, and only
    // one corpus file is multi-stage. Report rather than guess.
    const { measured, notes } = read(
      `${FLAGGED}<Stage2Mass>102.909</Stage2Mass>`, 2);
    expect(measured).toBeUndefined();
    expect(notes).toMatch(/multi-stage|two-stage|per stage/i);
    expect(notes).toMatch(/292/);
  });

  it('leaves a file with no design-level override completely alone', () => {
    expect(read('').measured).toBeUndefined();
    expect(read('').notes).not.toMatch(/Measured mass/i);
  });
});

/**
 * RockSim's <IgnitionDelay> is an offset from the STAGE BELOW'S BURNOUT, not
 * from liftoff. Getting this backwards lights a sustainer tens of seconds
 * early. It shipped once as 'launch' and was caught in review; these pin it.
 */
describe('.rkt staging timers', () => {
  const staged = (d: [string, string, string]) => `<RockSimDocument><DesignInformation><RocketDesign>
    <Name>Staged</Name><StageCount>3</StageCount>
    <!-- RockSim numbers its stage blocks from the TOP: Stage3Parts is the
         sustainer and Stage1Parts is the one that leaves the pad. Verified
         against SS Wild Bash 20260623v0.rkt, whose tree comes out
         [Sustainer, Booster, Booster 2]. -->
    <Stage3Parts><BodyTube><Name>Upper</Name><OD>54</OD><ID>52</ID><Len>200</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>3</SerialNo></BodyTube></Stage3Parts>
    <Stage2Parts><BodyTube><Name>Mid</Name><OD>54</OD><ID>52</ID><Len>250</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>2</SerialNo></BodyTube></Stage2Parts>
    <Stage1Parts><BodyTube><Name>Lower</Name><OD>54</OD><ID>52</ID><Len>300</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>1</SerialNo></BodyTube></Stage1Parts>
    <SimulationResultsList><SimulationResults>
      <Stage1Engines><EngineSet><EngineCode>L2200G</EngineCode>
        <IgnitionDelay>${d[0]}</IgnitionDelay><MountSerialNo>1</MountSerialNo>
        <EjectionDelay>0.</EjectionDelay></EngineSet></Stage1Engines>
      <Stage2Engines><EngineSet><EngineCode>K250W</EngineCode>
        <IgnitionDelay>${d[1]}</IgnitionDelay><MountSerialNo>2</MountSerialNo>
        <EjectionDelay>0.</EjectionDelay></EngineSet></Stage2Engines>
      <Stage3Engines><EngineSet><EngineCode>L265MY</EngineCode>
        <IgnitionDelay>${d[2]}</IgnitionDelay><MountSerialNo>3</MountSerialNo>
        <EjectionDelay>0.</EjectionDelay></EngineSet></Stage3Engines>
    </SimulationResults></SimulationResultsList>
  </RocketDesign></DesignInformation></RockSimDocument>`;

  const byDesignation = (xml: string) => Object.fromEntries(
    Object.values(importRkt(xml).motors).map((m) => [m.designation, m]));

  it('reads the delay as a BURNOUT offset on every stage above the launch stage', () => {
    const m = byDesignation(staged(['0.', '5.', '15.']));
    expect(m['K250W']!.ignitionEvent).toBe('burnout');
    expect(m['K250W']!.ignitionDelay).toBe(5);
    expect(m['L265MY']!.ignitionEvent).toBe('burnout');
    expect(m['L265MY']!.ignitionDelay).toBe(15);
  });

  // 'automatic' on an upper stage is the stage-below's EJECTION CHARGE, a
  // different event from its burnout — so an explicit 0 still has to say
  // burnout. The first version of this guard keyed on `delay > 0` and missed it.
  it('still says burnout for an upper stage whose delay is exactly 0', () => {
    const m = byDesignation(staged(['0.', '0.', '0.']));
    expect(m['K250W']!.ignitionEvent).toBe('burnout');
    expect(m['K250W']!.ignitionDelay).toBe(0);
  });

  it('leaves the LAUNCH stage alone, so single-stage files are untouched', () => {
    const m = byDesignation(staged(['0.', '5.', '15.']));
    expect(m['L2200G']!.ignitionEvent).toBeUndefined();
    expect(m['L2200G']!.ignitionDelay).toBeUndefined();
  });
});

/**
 * A design saved from here must come back the same way — including through
 * RockSim itself. The importer reads <IgnitionDelay>; the exporter has to write
 * it, or a staged design loses its staging every time it is saved.
 */
describe('.rkt staging timers round-trip', () => {
  it('writes the burnout delay back, and re-reads it unchanged', () => {
    const tree = {
      name: 'RT',
      components: [
        { type: 'stage', name: 'Sustainer', id: 's0', children: [
          { type: 'bodytube', id: 'm0', length: 0.2, outerRadius: 0.027, thickness: 0.001,
            motorMount: true },
        ] },
        { type: 'stage', name: 'Booster', id: 's1', children: [
          { type: 'bodytube', id: 'm1', length: 0.3, outerRadius: 0.027, thickness: 0.001,
            motorMount: true },
        ] },
      ] as ComponentNode[],
    };
    const xml = exportRkt({
      name: 'RT',
      tree,
      motors: {
        m0: { designation: 'K250W', diameter: 0.054, length: 0.3, delay: 4,
          ignitionEvent: 'burnout', ignitionDelay: 12 },
        m1: { designation: 'L2200G', diameter: 0.075, length: 0.5, delay: 0 },
      },
    });
    expect(xml).toContain('<IgnitionDelay>12</IgnitionDelay>');

    const back = importRkt(xml);
    const byDes = Object.fromEntries(
      Object.values(back.motors).map((m) => [m.designation, m]));
    expect(byDes['K250W']!.ignitionEvent).toBe('burnout');
    expect(byDes['K250W']!.ignitionDelay).toBe(12);
    // The launch stage stays on the kernel's own default.
    expect(byDes['L2200G']!.ignitionEvent).toBeUndefined();
  });
});

describe('RockSim import — a part matched to its catalogue row by <PartMfg>/<PartNo> (ruled 2026-09-03)', () => {
  // TubeFins2's chute is Apogee 29115 with RockSim's 0.75 "auto" Cd. Re-badge that ONE
  // block as the Fruity Chutes 96" toroidal the owner's Wildman carries (part 29185), so
  // the field the file leaves unset — the Cd — is exactly the one the catalogue must fill.
  const rebadged = (() => {
    const src = fixture('TubeFins2.rkt');
    const [head, rest] = src.split('<Parachute>') as [string, string];
    const [block, tail] = rest.split('</Parachute>') as [string, string];
    const b = block
      .replace(/<PartMfg>[^<]*<\/PartMfg>/, '<PartMfg>Fruity Chutes</PartMfg>')
      .replace(/<PartNo>[^<]*<\/PartNo>/, '<PartNo>29185</PartNo>');
    return `${head}<Parachute>${b}</Parachute>${tail}`;
  })();
  const chuteOf = (r: ReturnType<typeof importRkt>) =>
    flatten(r.tree.components).find((c) => c.type === 'parachute')!;

  it("takes the catalogue Cd for the 0.75 auto sentinel, and keeps the file's own dimensions", async () => {
    const r = importRkt(rebadged, { presets: await loadPresets() });
    const chute = chuteOf(r);
    expect(chute['cd']).toBe(2.2);
    expect(chute['spillHoleDiameter']).toBeGreaterThan(0);
    expect(chute['presetManufacturer']).toBe('Fruity Chutes');
    // 29185 was dropped as a duplicate on 2026-09-03; the link resolves through
    // the surviving row's altPartNos and stamps that row's number.
    expect(chute['presetPartNo']).toBe('IFC-096-N');
    expect(chute['diameter']).toBeCloseTo(0.6096, 9);   // the file's 609.6 mm, not the catalogue's 96 in
    expect(chute['lineCount']).toBe(6);                  // the file's 6, not the catalogue's
    expect(chute['overrideMass']).toBeUndefined();       // the catalogue never supplies the mass
    expect(r.notes.some((n) => /matched the parts catalogue/.test(n))).toBe(true);
  });

  it('without a catalogue nothing changes: the auto Cd stays auto', () => {
    const chute = chuteOf(importRkt(rebadged));
    expect(chute['cd']).toBeUndefined();
    expect(chute['presetPartNo']).toBeUndefined();
  });

  it('a "Custom" part is never linked, even when its part number would match', async () => {
    const custom = rebadged.replace('<PartMfg>Fruity Chutes</PartMfg>', '<PartMfg>Custom</PartMfg>');
    const chute = chuteOf(importRkt(custom, { presets: await loadPresets() }));
    expect(chute['cd']).toBeUndefined();
    expect(chute['presetPartNo']).toBeUndefined();
  });

  it("round-trips the link as <PartMfg>/<PartNo>, RockSim's own convention", async () => {
    const presets = await loadPresets();
    const r = importRkt(rebadged, { presets });
    const xml = exportRkt({ name: 'RT', tree: r.tree });
    const block = xml.split('<Parachute>')[1]!.split('</Parachute>')[0]!;
    expect(block).toContain('<PartMfg>Fruity Chutes</PartMfg>');
    // We write the CANONICAL row we linked to, not the dropped duplicate the
    // file happened to name — the export states what the design now holds.
    expect(block).toContain('<PartNo>IFC-096-N</PartNo>');
    const back = chuteOf(importRkt(xml, { presets }));
    expect(back['presetPartNo']).toBe('IFC-096-N');
    expect(back['cd']).toBe(2.2);
  });
});

describe('RockSim <SimulationEventList> — dual deploy actually deploys dually (v0.098)', () => {
  // Until v0.098 nothing read this list, so every device fell to the kernel
  // default and a dual-deploy design flew drogue and main together at ejection.
  // The type codes are undocumented and OpenRocket never read them; they are
  // pinned from 13 corpus files — see readDeploymentEvents' docstring.
  const evXml = (events: string) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>T</Name><StageCount>1</StageCount>
      <SimulationEventList>${events}</SimulationEventList>
      <Stage3Parts><BodyTube><Name>Body</Name><SerialNo>1</SerialNo><Len>500.</Len>
        <OD>100.</OD><ID>98.</ID><Density>0</Density><DensityType>0</DensityType>
        <AttachedParts>
          <Parachute><Name>Main</Name><SerialNo>12</SerialNo><Dia>2438.4</Dia>
            <Density>0.0054</Density><DensityType>1</DensityType><ShroudLineCount>18</ShroudLineCount></Parachute>
          <Parachute><Name>Drogue</Name><SerialNo>13</SerialNo><Dia>381.</Dia>
            <Density>0.0054</Density><DensityType>1</DensityType><ShroudLineCount>18</ShroudLineCount></Parachute>
        </AttachedParts></BodyTube></Stage3Parts>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  const ev = (serial: number, type: number, alt = 0, time = 0) =>
    `<SimulationEvent><PartSerialNo>${serial}</PartSerialNo><Type>${type}</Type>`
    + `<DeployAltitude>${alt}</DeployAltitude><DeplyTime>${time}</DeplyTime></SimulationEvent>`;
  const chutes = (xml: string) => {
    const r = importRkt(xml);
    const all = flatten(r.tree.components).filter((c) => c.type === 'parachute');
    return { r, main: all.find((c) => c.name === 'Main')!, drogue: all.find((c) => c.name === 'Drogue')! };
  };

  it('type 5 + DeployAltitude is the main at altitude; type 4 is the drogue at apogee', () => {
    const { r, main, drogue } = chutes(evXml(ev(12, 5, 152.4) + ev(13, 4)));
    expect(main['deployEvent']).toBe('altitude');
    expect(main['deployAltitude']).toBeCloseTo(152.4, 6);
    expect(drogue['deployEvent']).toBe('apogee');
    expect(drogue['deployAltitude']).toBeUndefined();
    expect(r.notes.some((n) => /Recovery deployment read from the file/.test(n))).toBe(true);
  });

  it('type 1 is the ejection charge, and type 2 carries its delay', () => {
    const { main, drogue } = chutes(evXml(ev(12, 2, 0, 2) + ev(13, 1)));
    expect(main['deployEvent']).toBe('ejection');
    expect(main['deployDelay']).toBe(2);
    expect(drogue['deployEvent']).toBe('ejection');
    expect(drogue['deployDelay']).toBeUndefined();
  });

  it("the padding slots RockSim writes (serial 0, type 0) are skipped, not mapped", () => {
    const { main } = chutes(evXml(ev(0, 0) + ev(0, 0) + ev(12, 4)));
    expect(main['deployEvent']).toBe('apogee');
  });

  it('the FIRST simulation slot wins when the repeated lists disagree', () => {
    // 2,4-D.rkt really does this: serial 26 is type 2 / 2 s in the first slot
    // and type 5 / 152.4 m in the second.
    const { main } = chutes(evXml(ev(12, 4) + ev(12, 5, 152.4)));
    expect(main['deployEvent']).toBe('apogee');
  });

  it('an unrecognised code leaves the device alone and SAYS so, rather than guessing', () => {
    const { r, main } = chutes(evXml(ev(12, 28)));
    expect(main['deployEvent']).toBeUndefined();
    expect(r.notes.some((n) => /does not recognise \(28\)/.test(n))).toBe(true);
  });

  it("an altitude trigger naming no altitude reads as apogee, not as 0 m", () => {
    const { main } = chutes(evXml(ev(12, 5, 0)));
    expect(main['deployEvent']).toBe('apogee');
    expect(main['deployAltitude']).toBeUndefined();
  });

  // The owner's real file is the case this was built for, but `docs/User files/`
  // is gitignored — his designs are not ours to commit — so this runs locally
  // and skips on CI, the same pattern lemivSweep.test.ts uses for the same
  // reason. (It skipped straight past me once: an absolute path to it failed the
  // deploy, which is the gate working.)
  const WM = join(here, '../../../../docs/User files/4in WM Extreme.rkt');
  it.skipIf(!existsSync(WM))("his own Wildman file: main at 152.4 m, drogue at apogee", () => {
    const r = importRkt(readFileSync(WM, 'utf8'));
    const all = flatten(r.tree.components).filter((c) => c.type === 'parachute');
    const main = all.find((c) => c.name === 'Main Parachute')!;
    const drogue = all.find((c) => /Drouge/i.test(String(c.name)))!;
    expect(main['deployEvent']).toBe('altitude');
    expect(main['deployAltitude']).toBeCloseTo(152.4, 6);
    expect(drogue['deployEvent']).toBe('apogee');
  });
});

describe('RockSim LINE density is kg/m both ways — ROCKSIM_TO_OPENROCKET_LINE_DENSITY = 1 (fixed v0.097)', () => {
  it('a shock cord weighs what the file says, not 10x', () => {
    const r = importRkt(fixture('TubeFins2.rkt'));
    const cord = flatten(r.tree.components).find((c) => c.type === 'shockcord')!;
    // File: <Density>0.00039698</Density> <DensityType>2</DensityType>. Desktop's
    // BaseHandler.computeDensity divides by 1; until v0.097 we divided by 0.1.
    expect(cord['lineDensity']).toBeCloseTo(0.00039698, 12);
  });

  it('and exports it back at the same value', () => {
    const r = importRkt(fixture('TubeFins2.rkt'));
    const xml = exportRkt({ name: 'RT', tree: r.tree });
    const cordBlock = xml.split('<MassObject>').find((b) => b.includes('<TypeCode>1</TypeCode>'))!;
    const density = Number(/<Density>([^<]*)<\/Density>/.exec(cordBlock)![1]);
    expect(density).toBeCloseTo(0.00039698, 12);
    expect(cordBlock).toContain('<DensityType>2</DensityType>');
  });
});

/**
 * A4 — RockSim's <ShapeParameter> on a TRANSITION.
 *
 * The nose branch read it; the transition branch never did, so a power, Haack or
 * parabolic transition silently took the kernel's default exponent. Desktop reads
 * it for both (TransitionHandler.java:102-107 mirrors NoseConeHandler.java:96-107)
 * and writes it for both (AbstractTransitionDTO.java:41-42, :72-76).
 *
 * Measured on the corpus: 5 transitions in 4 of 953 files move, two of them
 * materially — Exa.rkt's two power transitions (0.21 and 0.13 against a default of
 * 0.5) are +15.3 % on CD at M0.3 and −6.5 % on stability.
 */
describe('RockSim ShapeParameter — transitions read and written like nose cones', () => {
  /** One stage holding a nose cone plus the given transition blocks. */
  const design = (transitions: string) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>SP</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>24</BaseDia>
          <ShapeCode>4</ShapeCode><ShapeParameter>0.63</ShapeParameter></NoseCone>
        ${transitions}
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  const transitionsOf = (transitions: string) =>
    flatten(importRkt(design(transitions)).tree.components).filter((c) => c.type === 'transition');

  const T = (shapeCode: number, param: string, name: string) =>
    `<Transition><Name>${name}</Name><Len>50</Len><FrontDia>24</FrontDia><RearDia>18</RearDia>`
    + `<ShapeCode>${shapeCode}</ShapeCode><ShapeParameter>${param}</ShapeParameter></Transition>`;

  it('applies it for power, Haack and parabolic transitions', () => {
    const [power, haack, parabolic] = transitionsOf(
      T(4, '0.21', 'Power') + T(6, '0.3', 'Haack') + T(5, '0.4', 'Parabolic'));
    expect(power!['shape']).toBe('power');
    expect(power!['shapeParameter']).toBeCloseTo(0.21, 9);
    expect(haack!['shape']).toBe('haack');
    expect(haack!['shapeParameter']).toBeCloseTo(0.3, 9);
    expect(parabolic!['shape']).toBe('parabolic');
    expect(parabolic!['shapeParameter']).toBeCloseTo(0.4, 9);
  });

  it('IGNORES it for ogive and conical — RockSim stores a different quantity there', () => {
    // 51 corpus nose cones carry an ogive ShapeParameter of 4.2, outside
    // OpenRocket's 0-1 ogive range. Desktop gates on the same three shapes.
    const [ogive, conical] = transitionsOf(T(1, '0.9', 'Ogive') + T(0, '0.9', 'Conical'));
    expect(ogive!['shapeParameter']).toBeUndefined();
    expect(conical!['shapeParameter']).toBeUndefined();
  });

  it('exports it AFTER <ShapeCode> — desktop reads it with a SAX handler', () => {
    // Emitted before <ShapeCode>, desktop silently drops the value: its branch
    // tests the shape type set when <ShapeCode> closed. Our own reader is DOM-based
    // and order-free, so nothing but this assertion catches a mistake here.
    const xml = exportRkt({
      name: 'SP',
      tree: { name: 'SP', components: [{ type: 'stage', id: 's', children: [
        { type: 'transition', id: 't', shape: 'power', shapeParameter: 0.21, length: 0.05 },
      ] }] } as never,
    });
    const block = /<Transition>[\s\S]*?<\/Transition>/.exec(xml)![0];
    expect(block).toContain('<ShapeParameter>0.21</ShapeParameter>');
    expect(block.indexOf('<ShapeParameter>')).toBeGreaterThan(block.indexOf('<ShapeCode>'));
  });

  it('round-trips a power nose and power/Haack transitions', () => {
    const first = importRkt(design(T(4, '0.21', 'Power') + T(6, '0.3', 'Haack')));
    const again = importRkt(exportRkt({ name: 'SP', tree: first.tree }));
    const nose = flatten(again.tree.components).find((c) => c.type === 'nosecone')!;
    const [power, haack] = flatten(again.tree.components).filter((c) => c.type === 'transition');
    expect(nose['shapeParameter']).toBeCloseTo(0.63, 9);
    expect(power!['shapeParameter']).toBeCloseTo(0.21, 9);
    expect(haack!['shapeParameter']).toBeCloseTo(0.3, 9);
  });

  it('writes a literal 0 for a shape RockSim does not parameterise, stale value or not', () => {
    // PropertyPanel hides the field for a conical transition but never clears it,
    // so a stale value is reachable in the app. Desktop writes 0 there
    // (AbstractTransitionDTO.java:42 default + :72-76 gate) and so does RockSim.
    const xml = exportRkt({
      name: 'SP',
      tree: { name: 'SP', components: [{ type: 'stage', id: 's', children: [
        { type: 'nosecone', id: 'n', shape: 'ogive', length: 0.1 },
        { type: 'transition', id: 't', shape: 'conical', shapeParameter: 0.3, length: 0.05 },
      ] }] } as never,
    });
    const cone = /<NoseCone>[\s\S]*?<\/NoseCone>/.exec(xml)![0];
    const trans = /<Transition>[\s\S]*?<\/Transition>/.exec(xml)![0];
    expect(cone).toContain('<ShapeParameter>0</ShapeParameter>');
    expect(trans).toContain('<ShapeParameter>0</ShapeParameter>');
    // A gated shape with no value still falls back to the KERNEL default, never 0 —
    // a power-law part exported with exponent 0 re-imports as a blunt cylinder.
    const power = exportRkt({
      name: 'SP',
      tree: { name: 'SP', components: [{ type: 'stage', id: 's', children: [
        { type: 'nosecone', id: 'n', shape: 'power', length: 0.1 },
      ] }] } as never,
    });
    expect(power).toContain('<ShapeParameter>0.5</ShapeParameter>');
  });
});

/**
 * A1 — a RockSim mass object is a POINT at <Xb>, not a body of length <Len>.
 *
 * RockSim stores a length but treats the part as a point and does not show the
 * length in its own UI (desktop MassObjectHandler.java:29-39 says so). All 28
 * TypeCode-0 objects across the 14-file corpus write <KnownCG> == <Xb>. Our kernel
 * puts a MassObject's CG at length/2 (MassObject.java:230-231), so with no pin the
 * point landed half a length away — measured, Mach 3.rkt's whole-rocket CG sat
 * 110.6 mm aft of what its own <Station> values state, and 2,4-D.rkt's static
 * margin read 1.49 cal against a true 4.19.
 */
describe('RockSim mass objects are points, not bodies', () => {
  const design = (fields: string) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>MO</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>24</OD><ID>22</ID>
          <AttachedParts>
            <MassObject><Name>Sled</Name><TypeCode>0</TypeCode><KnownMass>100</KnownMass>
              ${fields}
            </MassObject>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  const massObject = (fields: string) =>
    flatten(importRkt(design(fields)).tree.components).find((c) => c.type === 'masscomponent')!;

  it('pins the CG at the component front for LocationMode 0, and clamps a runaway Len', () => {
    // Len 1524 mm inside a 300 mm tube. Desktop pins 0 here too
    // (MassObjectHandler.java:107); the clamp is ours, so the Length stat tile and
    // the pitch inertia stop being driven by a body longer than the rocket.
    const n = massObject('<Len>1524</Len><Xb>200</Xb><LocationMode>0</LocationMode>'
      + '<KnownCG>200</KnownCG><UseKnownCG>1</UseKnownCG>');
    expect(n['overrideCGX']).toBe(0);
    expect(n['rocksimLen']).toBeCloseTo(1.524, 9);
    expect(n['length']).toBeCloseTo(0.3, 9);
  });

  it('pins the CG at the component REAR for LocationMode 2 — where desktop gets it wrong', () => {
    // BOTTOM anchors the AFT end on the point, and overrideCGX is measured from the
    // FORE end (MassCalculation.java:444-445), so the pin is the component's length.
    // Desktop pins 0 and lands a full length forward of the file's own <Station>.
    const n = massObject('<Len>1524</Len><Xb>250</Xb><LocationMode>2</LocationMode>'
      + '<KnownCG>250</KnownCG><UseKnownCG>1</UseKnownCG>');
    expect(n.position).toEqual({ method: 'bottom', offset: -0.25 });
    expect(n['overrideCGX']).toBeCloseTo(n['length'] as number, 9);
  });

  it('leaves a mass object that fits its parent unclamped', () => {
    const n = massObject('<Len>20</Len><Xb>100</Xb><LocationMode>0</LocationMode>');
    expect(n['length']).toBeCloseTo(0.02, 9);
    expect(n['rocksimLen']).toBeCloseTo(0.02, 9);
  });

  it('leaves a SHOCK CORD alone — its packed length is a separate question', () => {
    const xml = design('<Len>3000</Len><Xb>100</Xb><LocationMode>0</LocationMode>')
      .replace('<TypeCode>0</TypeCode>', '<TypeCode>1</TypeCode>');
    const cord = flatten(importRkt(xml).tree.components).find((c) => c.type === 'shockcord')!;
    expect(cord['overrideCGX']).toBeUndefined();
  });

  it('says so in the import notes', () => {
    const r = importRkt(design('<Len>1524</Len><Xb>200</Xb><LocationMode>0</LocationMode>'));
    expect(r.notes.join(' ')).toContain('1 mass object placed at the exact point the file states');
  });

  it('exports <KnownCG> equal to <Xb>, and keeps it before <UseKnownCG>', () => {
    // Desktop MassObjectDTO.java:38-39 overrides BasePartDTO with
    // setKnownCG(getXb()) + setUseKnownCG(1) for EVERY MassObject. Order matters:
    // desktop's simplesax applies setOverride when <UseKnownCG> closes, using the
    // CG read so far (BaseHandler.java:94-98).
    const xml = exportRkt({
      name: 'MO',
      tree: { name: 'MO', components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, children: [
          { type: 'masscomponent', id: 'm1', mass: 0.1, length: 0.02,
            position: { method: 'top', offset: 0.2 } },
          { type: 'masscomponent', id: 'm2', mass: 0.1, length: 0.02,
            position: { method: 'bottom', offset: -0.1 } },
        ] },
      ] }] } as never,
    });
    const blocks = xml.match(/<MassObject>[\s\S]*?<\/MassObject>/g)!;
    expect(blocks[0]).toContain('<KnownCG>200</KnownCG>');
    expect(blocks[0]).toContain('<Xb>200</Xb>');
    expect(blocks[1]).toContain('<KnownCG>100</KnownCG>');
    expect(blocks[1]).toContain('<Xb>100</Xb>');
    for (const b of blocks) {
      expect(b.indexOf('<KnownCG>')).toBeLessThan(b.indexOf('<UseKnownCG>'));
    }
  });

  it('writes the file’s ORIGINAL <Len> back, not the clamped body', () => {
    const r = importRkt(design('<Len>1524</Len><Xb>200</Xb><LocationMode>0</LocationMode>'));
    const xml = exportRkt({ name: 'MO', tree: r.tree });
    const block = /<MassObject>[\s\S]*?<\/MassObject>/.exec(xml)![0];
    expect(block).toContain('<Len>1524</Len>');
  });

  it('round-trips both modes: pin, position and raw Len all survive', () => {
    for (const [mode, xb] of [[0, 200], [2, 250]] as const) {
      const first = importRkt(design(
        `<Len>1524</Len><Xb>${xb}</Xb><LocationMode>${mode}</LocationMode>`));
      const before = flatten(first.tree.components).find((c) => c.type === 'masscomponent')!;
      const again = importRkt(exportRkt({ name: 'MO', tree: first.tree }));
      const after = flatten(again.tree.components).find((c) => c.type === 'masscomponent')!;
      expect(after['overrideCGX']).toBeCloseTo(before['overrideCGX'] as number, 9);
      expect(after['rocksimLen']).toBeCloseTo(1.524, 9);
      expect(after.position).toEqual(before.position);
    }
  });
});

/**
 * A2 — a nose cone's <BaseExtensionLen> is a real cylinder and must be imported.
 *
 * It is a cylinder at BaseDia, aft of the cone. Two fixture files prove it from
 * their own <Station> chains: rocksimTestRocket1.rkt has Len 396.875 +
 * BaseExtensionLen 66.675 = 463.55, which is exactly the next tube's <Station>; the
 * owner's 4in WM Extreme.rkt has 495 + 14.0005 -> 509. RockSim bills its mass too:
 * PELTZER-Warp-7.rkt's solid cone reconciles with its own <CalcMass> to 0.003 %
 * only when the extension is counted.
 *
 * DELIBERATE DIVERGENCE FROM DESKTOP: the string appears in ZERO .java files under
 * the 24.12 tree, so desktop has no handler and imports these rockets short — up to
 * 127 mm across 53 of 843 corpus designs.
 */
describe('RockSim nose cone base extension', () => {
  const ext = (chain: ComponentNode[]) =>
    chain.find((c) => c.type === 'bodytube' && c['rktBaseExtension'] === true);

  it('becomes a body tube at the cone base diameter, carrying no mass of its own', () => {
    const r = importRkt(fixture('rocksimTestRocket1.rkt'));
    const chain = r.tree.components[0]!.children!;
    const cone = chain[0]!;
    // Immediately behind the cone, not somewhere later in the chain.
    expect(chain[1]).toBe(ext(chain));
    const e = ext(chain)!;
    expect(e['length']).toBeCloseTo(0.066675, 9);
    expect(e['outerRadius']).toBeCloseTo(cone['aftRadius'] as number, 12);
    expect(e['thickness']).toBeCloseTo(0.002159, 9);
    // The cone's <KnownMass> already covers the extension, so it must add none.
    expect(e['overrideMass']).toBe(0);
  });

  it('puts the next part where the file own <Station> says — the assertion that pins it', () => {
    // __fixtures__/rocksimTestRocket1.rkt:272 states <Station>463.55</Station> for
    // the body tube after the cone. Written against that number, not a recomputed sum.
    const chain = importRkt(fixture('rocksimTestRocket1.rkt')).tree.components[0]!.children!;
    let station = 0;
    for (const c of chain) {
      if (c.type === 'bodytube' && c['rktBaseExtension'] !== true) break;
      station += (c['length'] as number) ?? 0;
    }
    expect(station).toBeCloseTo(0.46355, 9);
  });

  it('does not change a pinned cone rocket mass', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const r = importRkt(fixture('rocksimTestRocket1.rkt'));
    const info = OrkRocket.buildTree(engineTree(r.tree)).staticInfo();
    // 264.3 g. Without the zero override the extension would be billed twice: 290.4 g.
    expect(info.massEmpty).toBeCloseTo(0.2643, 3);
  }, 60000);

  it('bills a SOLID cone extension as solid, not as a zero-mass shell', async () => {
    // 8 of the 9 solid corpus cones state WallThickness 0, so copying the cone's
    // wall gives a tube of zero mass. Solid is expressed as thickness = outerRadius,
    // which carved BodyTube.java:248-252 turns into innerRadius 0.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Solid</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>50</BaseDia>
          <WallThickness>0</WallThickness><ShapeCode>0</ShapeCode>
          <ConstructionType>0</ConstructionType><BaseExtensionLen>50</BaseExtensionLen>
          <Density>680</Density><DensityType>0</DensityType></NoseCone>
        <BodyTube><Name>Tube</Name><Len>200</Len><OD>50</OD><ID>48</ID>
          <Density>680</Density><DensityType>0</DensityType></BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const r = importRkt(xml);
    const chain = r.tree.components[0]!.children!;
    const e = ext(chain)!;
    expect(e['overrideMass']).toBeUndefined(); // computed cone: the extension weighs its own
    expect(e['thickness']).toBeCloseTo(chain[0]!['aftRadius'] as number, 12);

    resetEngine();
    const withExt = OrkRocket.buildTree(engineTree(r.tree)).staticInfo().massEmpty;
    resetEngine();
    const noExt = OrkRocket.buildTree(engineTree({
      ...r.tree,
      components: [{ ...r.tree.components[0]!, children: chain.filter((c) => c !== e) }],
    } as never)).staticInfo().massEmpty;
    // A solid 50 mm x 50 mm cylinder at 680 kg/m^3: pi * 0.025^2 * 0.05 * 680.
    expect(withExt - noExt).toBeCloseTo(Math.PI * 0.025 ** 2 * 0.05 * 680, 6);
  }, 60000);

  it('folds back into <BaseExtensionLen> on export instead of writing an extra tube', () => {
    const src = fixture('rocksimTestRocket1.rkt');
    const r = importRkt(src);
    const xml = exportRkt({ name: r.name, tree: r.tree });
    expect(xml).toContain('<BaseExtensionLen>66.675</BaseExtensionLen>');
    expect((xml.match(/<BodyTube>/g) ?? []).length)
      .toBe((src.match(/<BodyTube>/g) ?? []).length);
  });

  it('survives a full round trip — mass and length both return', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const direct = importRkt(fixture('rocksimTestRocket1.rkt'));
    const round = importRkt(exportRkt({ name: direct.name, tree: direct.tree }));
    resetEngine();
    const a = OrkRocket.buildTree(engineTree(direct.tree)).staticInfo();
    resetEngine();
    const b = OrkRocket.buildTree(engineTree(round.tree)).staticInfo();
    expect(b.massEmpty).toBeCloseTo(a.massEmpty, 6);
    expect(b.length).toBeCloseTo(a.length, 6);
  }, 60000);

  it('refuses to fold a tube the user has edited', () => {
    for (const edit of [{ outerRadius: 0.09 }, { thickness: 0.009 }]) {
      const r = importRkt(fixture('rocksimTestRocket1.rkt'));
      const chain = r.tree.components[0]!.children!;
      Object.assign(ext(chain)!, edit);
      const xml = exportRkt({ name: r.name, tree: r.tree });
      expect(xml).toContain('<BaseExtensionLen>0</BaseExtensionLen>');
      expect((xml.match(/<BodyTube>/g) ?? []).length)
        .toBe((fixture('rocksimTestRocket1.rkt').match(/<BodyTube>/g) ?? []).length + 1);
    }
  });

  it('never drops the tube when the cone has no id to key the fold on', () => {
    const xml = exportRkt({
      name: 'NoId',
      tree: { name: 'NoId', components: [{ type: 'stage', id: 's', children: [
        { type: 'nosecone', length: 0.1, aftRadius: 0.025, thickness: 0.002 },
        { type: 'bodytube', id: 'b', length: 0.05, outerRadius: 0.025, thickness: 0.002,
          rktBaseExtension: true },
      ] }] } as never,
    });
    expect(xml).toContain('<BodyTube>');
  });

  it('adds nothing when the element is absent or zero', () => {
    const zero = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Z</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>24</BaseDia>
          <BaseExtensionLen>0.</BaseExtensionLen></NoseCone>
        <BodyTube><Name>Tube</Name><Len>200</Len><OD>24</OD><ID>22</ID></BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    expect(ext(importRkt(zero).tree.components[0]!.children!)).toBeUndefined();
    // FinsOnTransitions.rkt carries no such element at all.
    const none = importRkt(fixture('FinsOnTransitions.rkt'));
    expect(flatten(none.tree.components).some((c) => c['rktBaseExtension'] === true)).toBe(false);
  });
});

/**
 * A6 (export half) — <CalcMass>/<CalcCG> on every part.
 *
 * Desktop writes both (BasePartDTO.java:84-85), and its IMPORTER pins any AIRFOIL
 * fin set whose <UseKnownCG> is 0 to them (FinSetHandler.java:299-309) from a field
 * that defaults to 0.0d. A .rkt this app wrote carried neither, so every airfoil fin
 * set in it opened in desktop OpenRocket weighing ZERO GRAMS — measured on the
 * committed fixture auto-radius-15.03.ork, an 829 g set, 10.7 % of that rocket's dry
 * mass, with stability over-reported by 0.91 caliber.
 *
 * The fix has two halves and the exporter one alone is inert: App.tsx used to collect
 * compInfo only for nodes carrying exactly ONE of overrideMass/overrideCGX, and a fin
 * set with no override satisfies neither. These tests drive the export the way
 * App.tsx does, which is what would have caught that.
 */
describe('RockSim export writes CalcMass/CalcCG (desktop reads them for airfoil fins)', () => {
  /** The compInfo map App.tsx builds — every node with an id, not just overridden ones. */
  const collectCompInfo = (
    built: { componentInfo: (id: string) => { mass: number; cgX: number } },
    nodes: ComponentNode[],
  ): Record<string, { mass: number; cgX: number }> => {
    const out: Record<string, { mass: number; cgX: number }> = {};
    const walk = (ns: ComponentNode[]) => {
      for (const n of ns) {
        if (n.id) {
          try {
            const info = built.componentInfo(n.id);
            out[n.id] = { mass: info.mass, cgX: info.cgX };
          } catch { /* not in the engine tree */ }
        }
        walk(n.children ?? []);
      }
    };
    walk(nodes);
    return out;
  };

  it('never leaves an airfoil fin set with UseKnownCG=0 and no CalcMass', async () => {
    // The property that pins the desktop zero-mass bug, asserted on the emitted XML
    // rather than on one number: desktop's airfoil branch fires on exactly this
    // combination, and a missing CalcMass is what zeroes the part.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const { importOrk } = await import('./orkFile.js');
    const { readFileSync: read } = await import('node:fs');
    // A .ork is a zip, so it must arrive as bytes — and importOrk takes an
    // ArrayBuffer, which a Node Buffer's backing store has to be sliced out of.
    const buf = read(join(here, '__fixtures__', 'auto-radius-15.03.ork'));
    const r = importOrk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    resetEngine();
    const built = OrkRocket.buildTree(engineTree(r.tree));
    const xml = exportRkt({
      name: 'A', tree: r.tree, compInfo: collectCompInfo(built, r.tree.components),
    });
    const finBlocks = xml.match(/<FinSet>[\s\S]*?<\/FinSet>/g) ?? [];
    expect(finBlocks.length).toBeGreaterThan(0);
    let airfoilChecked = 0;
    for (const b of finBlocks) {
      if (!b.includes('<TipShapeCode>2</TipShapeCode>')) continue;
      if (!b.includes('<UseKnownCG>0</UseKnownCG>')) continue;
      airfoilChecked += 1;
      const calc = /<CalcMass>([^<]*)<\/CalcMass>/.exec(b);
      expect(calc, 'an airfoil fin set exported without <CalcMass> reads 0 g in desktop OR').toBeTruthy();
      expect(Number(calc![1])).toBeGreaterThan(0);
    }
    expect(airfoilChecked).toBeGreaterThan(0);
  }, 60000);

  it('writes the numbers the app itself shows, after <Xb> where RockSim puts them', () => {
    const xml = exportRkt({
      name: 'C',
      tree: { name: 'C', components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.025, thickness: 0.001 },
      ] }] } as never,
      // Exactly representable in binary: the exporter emits raw JS numbers, so a
      // value like 0.1234 would print as 123.39999999999999 and the assertion would
      // be about floating point rather than about the element.
      compInfo: { b: { mass: 0.125, cgX: 0.15 } },
    });
    const block = /<BodyTube>[\s\S]*?<\/BodyTube>/.exec(xml)![0];
    expect(block).toContain('<CalcMass>125</CalcMass>');
    expect(block).toContain('<CalcCG>150</CalcCG>');
    expect(block.indexOf('<CalcMass>')).toBeGreaterThan(block.indexOf('<Xb>'));
  });

  it('omits them entirely when the caller supplied no computed info', () => {
    const xml = exportRkt({
      name: 'C',
      tree: { name: 'C', components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.025, thickness: 0.001 },
      ] }] } as never,
    });
    expect(xml).not.toContain('<CalcMass>');
  });
});

/**
 * v0.103 — `LaunchLug/RadialAngle`, which was neither read nor written.
 *
 * RockSim stores a lug's clock angle around the body in RADIANS, and desktop
 * OpenRocket maps it straight onto the same field this app calls `angleOffset`
 * (rocksim/importt/LaunchLugHandler.java:76-78 calls setAngleOffset with no
 * conversion; rocksim/export/LaunchLugDTO.java:39 writes it back the same way).
 * This file already read RadialAngle for tube fins and for pods, so the lug was
 * the one gap — and it cost the whole placement in both directions. Named
 * casualty from the corpus: Level 3 Rocket's two lugs, stored at -1.0472 rad
 * (-60 deg), arrived with no angle at all and were flown at the kernel's
 * default of 180 — 120 degrees from where the builder put them, on the one
 * line the launch rail has to have clear.
 *
 * The angle changes no drag (a bump on a round body blocks the same air
 * whichever way round it sits, and LaunchLugCalc/TubeCalc read no angle); what
 * it changes is where the lug is drawn, whether the rail-interference strip
 * warns, and the lateral CG the kernel gives it.
 */
describe('RockSim launch-lug mounting angle', () => {
  const withAngle = (angleTag: string) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Lug</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>500</Len><OD>54</OD><ID>52</ID>
          <AttachedParts>
            <LaunchLug><Name>Lug</Name><Len>50</Len><OD>6</OD><ID>5</ID>${angleTag}</LaunchLug>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;

  const lugOf = (tree: { components: ComponentNode[] }) => tree.components[0]!.children!
    .flatMap((c) => c.children ?? []).find((c) => c.type === 'launchlug')!;

  it('reads a negative RadialAngle in radians (the Level 3 Rocket case)', () => {
    const lug = lugOf(importRkt(withAngle('<RadialAngle>-1.0472</RadialAngle>')).tree);
    expect(lug['angleOffset']).toBeCloseTo(-1.0472, 9);
  });

  it('reads an explicit zero as zero, not as absent', () => {
    // Zero is where RockSim puts a lug it was never told about, and it is also
    // a real choice. It must not become the kernel's 180.
    expect(lugOf(importRkt(withAngle('<RadialAngle>0</RadialAngle>')).tree)['angleOffset']).toBe(0);
    // No element at all stays absent — every drawing and the bridge read that
    // as 0 anyway, so nothing is invented here.
    expect(lugOf(importRkt(withAngle('')).tree)['angleOffset']).toBeUndefined();
  });

  it('writes the angle back out, and survives a full round trip', () => {
    const design = {
      name: 'Lug',
      tree: {
        name: 'Lug',
        components: [{
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.5, outerRadius: 0.027, thickness: 0.001,
            children: [{
              type: 'launchlug' as const, id: 'lug', length: 0.05,
              outerRadius: 0.003, thickness: 0.0005, angleOffset: -1.0472,
              position: { method: 'top' as const, offset: 0.1 },
            }],
          }],
        }],
      },
    };
    const xml = exportRkt(design);
    expect(xml).toContain('<RadialAngle>-1.0472</RadialAngle>');
    expect(lugOf(importRkt(xml).tree)['angleOffset']).toBeCloseTo(-1.0472, 9);
  });
});

/**
 * A6 (import half) — an airfoil fin set takes RockSim's own CalcMass/CalcCG.
 *
 * Desktop does this unconditionally (FinSetHandler.java:299-309): RockSim's older
 * dialect ignores the cross-section when it weighs a fin, while the kernel scales
 * an airfoil's volume by 0.85, so those sets import exactly 15 % light. Newer files
 * carrying <UseConstThickness> model the section themselves and go the other way.
 * Ruled ADOPT by Eric 2026-09-04.
 */
describe('RockSim airfoil fin sets take the file’s own computed mass and CG', () => {
  const design = (fields: string, tip = 2) => `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>AF</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Tube</Name><Len>300</Len><OD>50</OD><ID>48</ID>
          <AttachedParts>
            <FinSet><Name>Fins</Name><FinCount>3</FinCount><ShapeCode>0</ShapeCode>
              <RootChord>60</RootChord><TipChord>30</TipChord><SemiSpan>40</SemiSpan>
              <SweepDistance>20</SweepDistance><Thickness>3</Thickness>
              <TipShapeCode>${tip}</TipShapeCode>
              ${fields}
            </FinSet>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  const finsOf = (fields: string, tip = 2) =>
    flatten(importRkt(design(fields, tip)).tree.components)
      .find((c) => c.type === 'trapezoidfinset')!;

  it('pins both numbers when the cross-section is airfoil and no override was stated', () => {
    const n = finsOf('<CalcMass>138.211</CalcMass><CalcCG>153.76</CalcCG><UseKnownCG>0</UseKnownCG>');
    expect(n['crossSection']).toBe('airfoil');
    expect(n['overrideMass']).toBeCloseTo(0.138211, 9);
    expect(n['overrideCGX']).toBeCloseTo(0.15376, 9);
  });

  it('leaves a SQUARE or ROUNDED set alone — this is the airfoil branch only', () => {
    for (const tip of [0, 1]) {
      const n = finsOf('<CalcMass>138.211</CalcMass><CalcCG>153.76</CalcCG><UseKnownCG>0</UseKnownCG>', tip);
      expect(n['overrideMass'], `TipShapeCode ${tip}`).toBeUndefined();
      expect(n['overrideCGX'], `TipShapeCode ${tip}`).toBeUndefined();
    }
  });

  it('a stated measured mass WINS over CalcMass — desktop skips its airfoil branch there', () => {
    const n = finsOf('<KnownMass>120</KnownMass><KnownCG>150</KnownCG><UseKnownCG>1</UseKnownCG>'
      + '<CalcMass>95</CalcMass><CalcCG>100</CalcCG>');
    expect(n['overrideMass']).toBeCloseTo(0.12, 9);
    expect(n['overrideCGX']).toBeCloseTo(0.15, 9);
  });

  it('refuses to copy desktop’s two zero bugs', () => {
    // Desktop's calcMass/calcCg fields default to 0.0d and it pins them anyway,
    // silently zeroing the fin set. 1 of the 271 affected corpus sets would hit it.
    expect(finsOf('<UseKnownCG>0</UseKnownCG>')['overrideMass']).toBeUndefined();
    expect(finsOf('<CalcMass>0</CalcMass><UseKnownCG>0</UseKnownCG>')['overrideMass']).toBeUndefined();
    // A CalcCG of 0 leaves the CG computed rather than pinning it to the fin root.
    const n = finsOf('<CalcMass>50</CalcMass><CalcCG>0</CalcCG><UseKnownCG>0</UseKnownCG>');
    expect(n['overrideMass']).toBeCloseTo(0.05, 9);
    expect(n['overrideCGX']).toBeUndefined();
  });

  it('a body tube with a CalcMass is still untouched — the gate is the cross-section', () => {
    // Guards the pre-existing behaviour asserted elsewhere in this file: we do NOT
    // believe a CalcMass on an ordinary part whose flag is off.
    const tube = flatten(importRkt(
      design('<CalcMass>138.211</CalcMass><UseKnownCG>0</UseKnownCG>'),
    ).tree.components).find((c) => c.type === 'bodytube')!;
    expect(tube['overrideMass']).toBeUndefined();
  });

  it('says so in the import notes', () => {
    const r = importRkt(design('<CalcMass>138.211</CalcMass><CalcCG>153.76</CalcCG><UseKnownCG>0</UseKnownCG>'));
    expect(r.notes.join(' ')).toContain('1 airfoil fin set took the mass and balance point');
  });

  it('reaches the KERNEL, not just the node — the fin set really weighs the file’s number', async () => {
    // A node-field-only test proves nothing about physics: that is exactly how the
    // tube-fin wall thickness round-tripped through the file for months while the
    // kernel ignored it. Assert what the engine was handed.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const r = importRkt(design('<CalcMass>138.211</CalcMass><CalcCG>153.76</CalcCG><UseKnownCG>0</UseKnownCG>'));
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    resetEngine();
    const built = OrkRocket.buildTree(engineTree(r.tree));
    const info = built.componentInfo(fins.id!);
    expect(info.mass).toBeCloseTo(0.138211, 9);
    expect(info.cgX).toBeCloseTo(0.15376, 6);
  }, 60000);
});
