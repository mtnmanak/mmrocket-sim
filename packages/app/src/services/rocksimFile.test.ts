// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportRkt, importRkt, rktEveryDelay } from './rocksimFile.js';
import { exportOrk, importOrk, type OrkExportMotor } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { matchImportedMotor, refToExportMotor } from './motorMatch.js';
import { loadPresets } from './presets.js';
import { findDbMotor, MOTOR_DB } from './motorDb.js';
import { bundledSimFiles, defaultDelay, delayOptions } from './thrustcurve.js';
import { clusterOffsets } from '../tree/cluster.js';

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
    // ConstructionType 1 = hollow, and it is WRITTEN, not left unset: an unset
    // `filled` is what a catalogue link fills (audit 2026-09-22).
    expect(chain[0]!['filled']).toBe(false);
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

  /**
   * Every tube where the KERNEL puts it (InnerTube.getClusterPoints): the
   * pattern turned by clusterRotation − radialDirection, plus the tube's own
   * offset of radialPosition along radialDirection. The exporter passed neither
   * (audit 2026-09-22, row 358, from review), so a clustered tube with its own
   * direction went out unturned, and any off-axis tube went out on the axis.
   */
  it('writes each tube at the kernel’s position — its own direction and offset included', () => {
    const R = 0.0095;
    const xmlFor = (extra: Record<string, unknown>) => exportRkt({
      name: 'C', tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [{
            type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.05, thickness: 0.001,
            children: [{
              type: 'innertube' as const, id: 'm', length: 0.07, outerRadius: R,
              thickness: 0.0005, motorMount: true, ...extra,
            }],
          }],
        }],
      },
    });
    /** Each inside tube's centre, (y, z) in metres, from RadialLoc (mm) and RadialAngle (rad). */
    const centres = (xml: string) => [...xml.matchAll(
      /<IsInsideTube>1<\/IsInsideTube>\s*<RadialLoc>([^<]+)<\/RadialLoc>\s*<RadialAngle>([^<]+)<\/RadialAngle>/g)]
      .map((m) => ({ y: (Number(m[1]) / 1000) * Math.cos(Number(m[2])), z: (Number(m[1]) / 1000) * Math.sin(Number(m[2])) }));
    const expectAt = (got: { y: number; z: number }[], want: { y: number; z: number }[]) => {
      expect(got.length).toBe(want.length);
      got.forEach((c, i) => {
        expect(c.y).toBeCloseTo(want[i]!.y, 9);
        expect(c.z).toBeCloseTo(want[i]!.z, 9);
      });
    };
    // A single tube 12 mm off the axis, at 90°.
    expectAt(centres(xmlFor({ radialPosition: 0.012, radialDirection: Math.PI / 2 })), [{ y: 0, z: 0.012 }]);
    // A 3-ring on the axis with a 30° direction: the kernel turns it by +30°.
    const d = Math.PI / 6;
    const turned = clusterOffsets('3-ring', R).map((o) => ({
      y: o.y * Math.cos(d) - o.z * Math.sin(d), z: o.y * Math.sin(d) + o.z * Math.cos(d),
    }));
    expectAt(centres(xmlFor({ cluster: '3-ring', radialDirection: d })), turned);
    // A 3-ring set 20 mm off the axis along 0°: every tube shifted with it.
    expectAt(centres(xmlFor({ cluster: '3-ring', radialPosition: 0.02 })),
      clusterOffsets('3-ring', R).map((o) => ({ y: o.y + 0.02, z: o.z })));
    // And an on-axis tube still goes out as 0 / 0.
    expect(xmlFor({})).toMatch(/<RadialLoc>0<\/RadialLoc>\s*<RadialAngle>0<\/RadialAngle>/);
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

  /**
   * A ROTATED ring read from a real RockSim file must come back with the
   * rotation the KERNEL turns the same way (audit 2026-09-22, row 358). The
   * kernel turns a pattern by MINUS its clusterRotation; three tubes RockSim
   * places at 60°/180°/300° are a 3-ring the kernel calls +30°. The importer
   * matched the old +rotation drawing and read them as −30°, which the kernel
   * (and desktop, and now every view) puts at 0°/120°/240° — on the fin lines.
   */
  it('reads a rotated ring as the rotation the kernel turns the same way', () => {
    const tube = (n: number, angle: number) => `
      <BodyTube><Name>tube ${n}</Name><IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount>
        <OD>24</OD><ID>22</ID><Len>70</Len><Xb>0.</Xb>
        <RadialLoc>${24 / Math.sqrt(3)}</RadialLoc><RadialAngle>${angle}</RadialAngle>
      </BodyTube>`;
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Ring</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Body</Name><OD>100</OD><ID>98</ID><Len>300</Len>
          <AttachedParts>
            ${tube(1, Math.PI / 3)}${tube(2, Math.PI)}${tube(3, (5 * Math.PI) / 3)}
          </AttachedParts>
        </BodyTube>
      </Stage3Parts><Stage2Parts/><Stage1Parts/>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const ring = flatten(importRkt(xml).tree.components).find((c) => c.type === 'innertube')!;
    expect(ring['cluster']).toBe('3-ring');
    // +30° modulo the ring's own 120° symmetry.
    const rot = ring['clusterRotation'] as number;
    const k = Math.round((rot - Math.PI / 6) / ((2 * Math.PI) / 3));
    expect(rot - k * ((2 * Math.PI) / 3)).toBeCloseTo(Math.PI / 6, 6);
    // And the offsets the views and the exporter draw from it are where the
    // file put the tubes.
    const angles = clusterOffsets('3-ring', ring['outerRadius'] as number,
      ring['clusterScale'] as number, rot)
      .map((o) => ((Math.atan2(o.z, o.y) * 180) / Math.PI + 360) % 360)
      .sort((a, b) => a - b);
    expect(angles[0]).toBeCloseTo(60, 3);
    expect(angles[1]).toBeCloseTo(180, 3);
    expect(angles[2]).toBeCloseTo(300, 3);
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

  it('interleaves by the fin count that is drawn and flown, not the raw one sanitize clamps', () => {
    // The de-collision runs BEFORE sanitizeTree, and it divided by the file's raw
    // count: a TubeCount of 12 turned the second set 15° and said so, while
    // sanitize then made it 8 tubes, which need 22.5° (seam review of audit
    // 2026-09-22 — finAlign.ts's copy of this pass already used finCountOf).
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>UN</Name><StageCount>1</StageCount>
      <Stage3Parts>
        <BodyTube><Name>Booster</Name><OD>102</OD><ID>98</ID><Len>800</Len>
          <AttachedParts>
            <TubeFinSet><Name>Tube fins</Name><TubeCount>12</TubeCount><OD>20</OD><ID>19</ID><Len>150</Len>
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
    expect(all.find((c) => c.type === 'tubefinset')!['finCount']).toBe(8);
    expect(all.find((c) => c.type === 'trapezoidfinset')!['rotation']).toBeCloseTo(Math.PI / 8, 9);
    expect(r.notes.join(' ')).toMatch(/rotated 23° to interleave/);
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

/**
 * THE PAD STAGE'S DELAY, AND EVERY EVENT A .rkt CAN SAY (seam review of audit
 * 2026-09-22). Nothing burns below the stage that leaves the pad, so RockSim
 * counts ITS IgnitionDelay from launch — an air start. The reader dropped it
 * (42 simulations in 13 corpus files lit at t = 0, most of them the owner's),
 * although the writer had just been taught to write it; and the writer dropped
 * the delay of the kernel's default event, 'automatic', everywhere.
 */
describe('.rkt ignition delays — read and written for every event RockSim can say', () => {
  const twoStage = (): { name: string; components: ComponentNode[] } => ({
    name: 'RT',
    components: [
      { type: 'stage', name: 'Sustainer', id: 's0', children: [
        { type: 'bodytube', id: 'm0', length: 0.2, outerRadius: 0.027, thickness: 0.001, motorMount: true },
      ] },
      { type: 'stage', name: 'Booster', id: 's1', children: [
        { type: 'bodytube', id: 'm1', length: 0.3, outerRadius: 0.027, thickness: 0.001, motorMount: true },
      ] },
    ] as ComponentNode[],
  });
  const motor = (designation: string, extra: Partial<OrkExportMotor> = {}): OrkExportMotor => ({
    designation, manufacturer: 'AeroTech', diameter: 0.054, length: 0.3, delay: 0, ...extra,
  });
  const reread = (xml: string) => Object.fromEntries(
    Object.values(importRkt(xml).motors).map((m) => [m.designation, m]));

  it('reads a delay on the pad stage as launch plus that delay', () => {
    const one = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Air start</Name><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><Name>Body</Name><OD>98</OD><ID>96</ID><Len>900</Len><SerialNo>1</SerialNo>
        <AttachedParts>
          <BodyTube><Name>Core</Name><OD>40</OD><ID>38.4</ID><Len>300</Len><IsMotorMount>1</IsMotorMount><SerialNo>7</SerialNo></BodyTube>
          <BodyTube><Name>Outboard</Name><OD>31</OD><ID>29.5</ID><Len>200</Len><IsMotorMount>1</IsMotorMount>
            <RadialLoc>35</RadialLoc><SerialNo>8</SerialNo></BodyTube>
        </AttachedParts></BodyTube></Stage3Parts>
      <SimulationResultsList><SimulationResults><Stage3Engines>
        <EngineSet><EngineCode>I599N</EngineCode><EngineMfg>Cesaroni</EngineMfg><IgnitionDelay>0.</IgnitionDelay>
          <MountSerialNo>7</MountSerialNo><EjectionDelay>-2.</EjectionDelay></EngineSet>
        <EngineSet><EngineCode>H115DM</EngineCode><EngineMfg>Cesaroni</EngineMfg><IgnitionDelay>2.</IgnitionDelay>
          <MountSerialNo>8</MountSerialNo><EjectionDelay>-2.</EjectionDelay></EngineSet>
      </Stage3Engines></SimulationResults></SimulationResultsList>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    const m = reread(one);
    expect(m['H115DM']!.ignitionEvent).toBe('launch');
    expect(m['H115DM']!.ignitionDelay).toBe(2);
    // A 0 stays the kernel's own default, as every single-stage file always has.
    expect(m['I599N']!.ignitionEvent).toBeUndefined();
    expect(m['I599N']!.ignitionDelay).toBeUndefined();
  });

  it('writes and reads back automatic on the pad stage, and automatic above one whose motors share a delay', () => {
    const notes: string[] = [];
    const xml = exportRkt({
      name: 'RT', tree: twoStage(), notes,
      motors: {
        // The kernel's automatic: LAUNCH on the bottom stage …
        m1: motor('M1350W', { delay: 3, ignitionEvent: 'automatic', ignitionDelay: 12 }),
        // … and the charge of the stage below above it: 3 s after that burnout.
        m0: motor('K250W', { delay: 6, ignitionEvent: 'automatic', ignitionDelay: 1.5 }),
      },
    });
    expect(notes).toEqual([]);
    expect(xml).toContain('<SimulationName>[M1350W-3-12] [K250W-6-4.5] </SimulationName>');
    const m = reread(xml);
    expect([m['M1350W']!.ignitionEvent, m['M1350W']!.ignitionDelay]).toEqual(['launch', 12]);
    // The same instant, in RockSim's words: the booster's burnout + 3 s + 1.5 s.
    expect([m['K250W']!.ignitionEvent, m['K250W']!.ignitionDelay]).toEqual(['burnout', 4.5]);
  });

  it('round-trips launch on the pad stage and burnout above it unchanged', () => {
    const notes: string[] = [];
    const m = reread(exportRkt({
      name: 'RT', tree: twoStage(), notes,
      motors: {
        m1: motor('M1350W', { ignitionEvent: 'launch', ignitionDelay: 0.5 }),
        m0: motor('K250W', { ignitionEvent: 'burnout', ignitionDelay: 7 }),
      },
    }));
    expect(notes).toEqual([]);
    expect([m['M1350W']!.ignitionEvent, m['M1350W']!.ignitionDelay]).toEqual(['launch', 0.5]);
    expect([m['K250W']!.ignitionEvent, m['K250W']!.ignitionDelay]).toEqual(['burnout', 7]);
  });

  it('says what RockSim cannot: launch above the pad stage, a charge below that is plugged, never', () => {
    const cases: [Partial<OrkExportMotor>, Partial<OrkExportMotor>, RegExp][] = [
      [{ ignitionEvent: 'launch', ignitionDelay: 2 }, {}, /“K250W” lights at launch, above the stage that leaves the pad\. .* lights it 2 s after the burnout of the stage below\./],
      // A plugged motor fires no charge (the kernel schedules EJECTION_CHARGE
      // only for a motor with one), so here the stage above never lights —
      // one plugged motor shares 'plugged', so "do not share" was the wrong
      // reason (review of the seam fixes).
      [{ ignitionEvent: 'automatic' }, { delay: Infinity }, /“K250W” lights on the ejection charge of the stage below, whose motor is plugged — with no charge to fire, it does not light here either\. .* lights it 0 s after the burnout of the stage below\./],
      [{ ignitionEvent: 'never' }, {}, /“K250W” is set never to light\./],
    ];
    for (const [upper, booster, said] of cases) {
      const notes: string[] = [];
      exportRkt({ name: 'RT', tree: twoStage(), notes, motors: { m1: motor('M1350W', booster), m0: motor('K250W', upper) } });
      expect(notes).toEqual([expect.stringMatching(said)]);
    }
    // Two booster motors whose charges fire at different times: RockSim has one burnout to count from.
    const split = twoStage();
    split.components[1]!.children!.push({ type: 'bodytube', id: 'm2', length: 0.3, outerRadius: 0.027, thickness: 0.001, motorMount: true } as ComponentNode);
    const differ: string[] = [];
    exportRkt({ name: 'RT', tree: split, notes: differ, motors: {
      m1: motor('M1350W', { delay: 3 }), m2: motor('M1350W', { delay: 5 }), m0: motor('K250W', { ignitionEvent: 'automatic' }),
    } });
    expect(differ).toEqual([expect.stringMatching(/“K250W” lights on the ejection charge of the stage below, whose motors do not share one ejection delay\. /)]);
    // Burnout on the pad stage: nothing burns below it, so it never lights here.
    const notes: string[] = [];
    exportRkt({ name: 'RT', tree: twoStage(), notes, motors: { m1: motor('M1350W', { ignitionEvent: 'burnout', ignitionDelay: 1 }) } });
    expect(notes).toEqual([expect.stringMatching(/which never comes on the stage that leaves the pad, so it does not light here either\. .* lights it 1 s after launch\./)]);
  });

  it('38-54 2-stage.CDX1: the M1350W on automatic/12 s reopens from a .rkt still lit at 12 s', () => {
    const r = importCdx1(fixture('38-54 2-stage.CDX1'));
    const motors = Object.fromEntries(Object.entries(r.motors).map(([id, ref]) => [id, refToExportMotor(ref)]));
    const m1350 = Object.values(r.motors).find((m) => m.designation === 'M1350W')!;
    expect([m1350.ignitionEvent, m1350.ignitionDelay]).toEqual(['automatic', 12]);
    const back = reread(exportRkt({ name: '38-54', tree: r.tree, motors }));
    expect([back['M1350W']!.ignitionEvent, back['M1350W']!.ignitionDelay]).toEqual(['launch', 12]);
    expect([back['K627LR']!.ignitionEvent, back['K627LR']!.ignitionDelay]).toEqual(['burnout', 22]);
  });

  // The owner's own file, local-only: simulation 3 lights six H115DM 2 s after the I599N.
  const BRUISER = ['G:/Documents/Dropbox/Rocksim Designs', 'C:/Users/peltz/Dropbox/Rocksim Designs']
    .map((c) => `${c}/LOC Precision Rocketry/PELTZER - LOC Bruiser EXP v2_1x54mm_6x29mm.rkt`).find((p) => existsSync(p));
  it.skipIf(!BRUISER)('PELTZER - LOC Bruiser EXP v2_1x54mm_6x29mm.rkt: simulation 3 is an air start', () => {
    const r = importRkt(readFileSync(BRUISER!, 'latin1'));
    const sim3 = r.configs.find((c) => c.id === 'rocksim-sim-3')!;
    const byDes = new Map(Object.values(sim3.motors).map((m) => [m.designation, m]));
    expect([byDes.get('H115DM-14A')!.ignitionEvent, byDes.get('H115DM-14A')!.ignitionDelay]).toEqual(['launch', 2]);
    expect(byDes.get('I599N')!.ignitionEvent).toBeUndefined();
  });
});

/**
 * RockSim's two negative <EjectionDelay> codes are SENTINELS (audit
 * 2026-09-22, HIGH): −2 is plugged (its simulations are named "[A8-P]" /
 * "[A8-Plugged]", 3,250 sets in the 939-file corpus) and −1 is its multi-delay
 * "every delay" run ("[H128W-*]", 1,113). Passed through as delays, both put
 * the charge before burnout and the kernel fired it AT burnout — the reference
 * C6 rocket's apogee fell 331.8 → 168.1 m.
 */
describe('RockSim ejection-delay sentinels', () => {
  const rkt = (engineSets: string[]) => `<RockSimDocument><DesignInformation><RocketDesign>
    <Name>Delays</Name><StageCount>1</StageCount>
    <Stage3Parts><BodyTube><Name>Body</Name><OD>24.8</OD><ID>24.1</ID><Len>300</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>7</SerialNo></BodyTube></Stage3Parts>
    <SimulationResultsList>${engineSets.map((s) => `<SimulationResults><Stage3Engines>
      <EngineSet><EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg>
        <IgnitionDelay>0.</IgnitionDelay><MountSerialNo>7</MountSerialNo>${s}</EngineSet>
    </Stage3Engines></SimulationResults>`).join('')}</SimulationResultsList>
  </RocketDesign></DesignInformation></RockSimDocument>`;
  const one = (s: string) => {
    const r = importRkt(rkt([s]));
    return { delay: Object.values(r.motors)[0]!.delay, notes: r.notes.join(' ') };
  };
  /** A cluster built as three separate mounts, one engine set each (PELTZER_Swarm_JR.rkt's shape). */
  const cluster = (code: string, mfr: string, ejectionDelay: string) => {
    const mounts = [7, 8, 9];
    return `<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Swarm</Name><StageCount>1</StageCount>
      <Stage3Parts>${mounts.map((s) => `<BodyTube><Name>Mount ${s}</Name><OD>24.8</OD><ID>24.1</ID>
        <Len>100</Len><IsMotorMount>1</IsMotorMount><SerialNo>${s}</SerialNo></BodyTube>`).join('')}
      </Stage3Parts>
      <SimulationResultsList><SimulationResults><Stage3Engines>${mounts.map((s) => `<EngineSet>
        <EngineCode>${code}</EngineCode><EngineMfg>${mfr}</EngineMfg><IgnitionDelay>0.</IgnitionDelay>
        <MountSerialNo>${s}</MountSerialNo><EjectionDelay>${ejectionDelay}</EjectionDelay></EngineSet>`).join('')}
      </Stage3Engines></SimulationResults></SimulationResultsList>
    </RocketDesign></DesignInformation></RockSimDocument>`;
  };

  it('−2 is plugged, and the note says so', () => {
    const { delay, notes } = one('<EjectionDelay>-2.</EjectionDelay>');
    expect(delay).toBe(Infinity);
    expect(notes).toMatch(/C6: plugged/);
  });

  it('−1 is the catalogue’s own default — the longest prescribed delay — never a negative', () => {
    // Estes C6 lists 0,3,5,7 in the shipped catalogue.
    const { delay, notes } = one('<EjectionDelay>-1.</EjectionDelay>');
    expect(delay).toBe(7);
    expect(notes).toMatch(/every delay/);
    expect(notes).toMatch(/7 s/);
  });

  /**
   * WHAT A SAVE WRITES FOR A REFERENCE NOTHING LOADED (review of the seam fixes,
   * 2026-09-22). v0.137 passed −1 through, so a .rkt Save handed RockSim its
   * "every delay" back. The sentinel fix resolved it to 0 s instead and every
   * Save wrote that — which reopens as an ordinary 0 s with no note, and fires
   * at burnout the day the motor becomes loadable. 8 of the owner's files reach
   * it (darkstar4.rkt's K1440-WT, Wildman.rkt's K570-Classic, Blackhawk29.rkt's
   * I204-IM …).
   */
  it('−1 on a motor the catalogue does not know is kept: −1 back to a .rkt, plugged to a .ork, never 0 s', () => {
    const r = importRkt(rkt(['<EjectionDelay>-1.</EjectionDelay>']).replace(/C6/g, 'ZQ9999X'));
    const ref = Object.values(r.motors)[0]!;
    expect(ref.delay).toBe(Infinity);
    expect(ref.rktEveryDelay).toBe(true);
    expect(ref.autoDelay).toBeUndefined();
    // The reason is the motor's ABSENCE, not an empty delay list (seam review of
    // audit 2026-09-22: all 8 corpus files that reach this note are unmatched
    // motors, and the old text sent the user to a delay box that does not exist).
    const note = r.notes.find((n) => /EjectionDelay −1/.test(n))!;
    expect(note).toMatch(/isn't in the motor database/);
    expect(note).not.toMatch(/lists no delay|Motors & Launch|0 s/);
    // Saved the way App saves a reference nothing matched.
    const motors = { [ref.mountId!]: refToExportMotor(ref) };
    const asRkt = exportRkt({ name: 'Delays', tree: r.tree, motors });
    expect(asRkt).toContain('<EjectionDelay>-1</EjectionDelay>');
    const again = importRkt(asRkt);
    expect(Object.values(again.motors)[0]!.delay).toBe(Infinity);
    expect(again.notes.find((n) => /EjectionDelay −1/.test(n))).toBe(note);
    // A .ork has no "every delay": plugged, which reopens with its own warning.
    const asOrk = exportOrk({ name: 'Delays', tree: r.tree, motors });
    expect(asOrk).toContain('<delay>none</delay>');
    const reopened = importOrk(asOrk);
    expect(Object.values(reopened.motors)[0]!.delay).toBe(Infinity);
    expect(reopened.notes).toContainEqual(expect.stringMatching(/^Motor ZQ9999X: plugged/));
  });

  /**
   * 80 catalogue motors have no simulator file on thrustcurve.org at all, so
   * the matcher loads nothing and says so. This note said "loaded at the
   * longest, 10 s … Change it on the Motors & Launch tab" right beside it
   * (review of the seam fixes, 2026-09-22). The reader cannot know — the curves
   * are a lazy bundle — so the note says what the REFERENCE carries.
   */
  it('−1 on a catalogue motor with no thrust curve names the delay it carries, never a load', async () => {
    const g80 = findDbMotor('G80', undefined, undefined, 'Estes')!;
    expect(delayOptions(g80)).toEqual([7, 10]);
    expect(await bundledSimFiles(g80.motorId)).toEqual([]);
    const r = importRkt(rkt(['<EjectionDelay>-1.</EjectionDelay>'])
      .replace('<EngineCode>C6</EngineCode>', '<EngineCode>G80</EngineCode>'));
    const ref = Object.values(r.motors)[0]!;
    expect(ref.delay).toBe(10);
    const note = r.notes.find((n) => /EjectionDelay −1/.test(n))!;
    expect(note).toMatch(/the longest, 10 s/);
    expect(note).not.toMatch(/loaded|Motors & Launch/);
    // And a Save of it, still unmatched, gives RockSim its −1 back.
    expect(exportRkt({ name: 'G80', tree: r.tree, motors: { [ref.mountId!]: refToExportMotor(ref) } }))
      .toContain('<EjectionDelay>-1</EjectionDelay>');
  });

  /**
   * THE BROWSER'S DEFAULT, PINNED (seam review of audit 2026-09-22). A motor the
   * catalogue KNOWS but whose delays are only letters (KBA's "M", "S,M,L") has
   * no numeric delay since the row-363 fix, and the motor browser answers that
   * with "Auto (optimal)". The importer recorded 0 s instead, so the charge fired
   * at burnout: the reference Cheetah with a G135R deployed at 250.9 m/s, against
   * 0.87 m/s on Auto. batchSweep.test.ts pins Batch to the browser the same way.
   */
  it('−1 on a catalogue motor that lists no numeric delay loads on Auto, as the browser starts it', () => {
    const r = importRkt(rkt(['<EjectionDelay>-1.</EjectionDelay>'])
      .replace('<EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg>',
        '<EngineCode>G135R</EngineCode><EngineMfg>KBA</EngineMfg>'));
    const ref = Object.values(r.motors)[0]!;
    expect(ref.designation).toBe('G135R');
    expect(ref.autoDelay).toBe(true);
    expect(ref.delay).toBe(0); // the browser's provisional first flight, re-flown at the optimum
    const note = r.notes.find((n) => /EjectionDelay −1/.test(n))!;
    expect(note).toMatch(/Auto \(optimal\)/);
    expect(note).not.toMatch(/0 s/);
  });

  /**
   * Auto delay re-flies the PRIMARY mount only (flightRunner.flyLaunch), as it
   * does for a motor browser pick, so a cluster built as separate mounts flies
   * every other mount at the provisional 0 s and its charge fires at burnout —
   * the Cheetah probe with its G135R mount cloned twice deployed at 1.05 s
   * (review of the seam fixes, 2026-09-22). The note said nothing of it.
   */
  it('−1 on a no-delay motor across several mounts says only the primary is re-flown', () => {
    const r = importRkt(cluster('G135R', 'KBA', '-1.'));
    expect(Object.values(r.motors).map((m) => m.autoDelay)).toEqual([true, true, true]);
    const said = r.notes.filter((n) => /EjectionDelay −1/.test(n));
    expect(said).toEqual([expect.stringMatching(/^Motor G135R \(3 mounts\): /)]);
    expect(said[0]).toMatch(/any of these 3 that is not it flies the provisional 0 s, so its charge fires at burnout/);
  });

  it('a plugged cluster saved as .ork reopens with one note, not one per mount', () => {
    // PELTZER_Swarm_JR.rkt, opened and saved as .ork: twelve identical lines on reopen.
    const r = importRkt(cluster('C6', 'Estes', '-2.'));
    const motors = Object.fromEntries(Object.entries(r.motors).map(([id, ref]) => [id, refToExportMotor(ref)]));
    const back = importOrk(exportOrk({ name: 'Swarm', tree: r.tree, motors }));
    expect(Object.values(back.motors)).toHaveLength(3);
    expect(back.notes.filter((n) => /plugged/.test(n)))
      .toEqual([expect.stringMatching(/^Motor C6 \(3 mounts\): plugged/)]);
  });

  it("pins the −1 rule to the motor browser's default pick, for every motor in the shipped catalogue", () => {
    const browser = readFileSync(join(here, '../components/MotorBrowser.tsx'), 'utf8');
    // Its default pick, and what its Auto load flies before App re-flies at the optimum.
    expect(browser).toContain("if (picked) setDelay(defaultDelay(picked) ?? 'auto');");
    expect(browser).toContain("const chosen = delay === 'auto' ? finite[finite.length - 1] ?? 0");
    let auto = 0;
    for (const m of MOTOR_DB) {
      // The motor the matcher will load for this reference — a .rkt carries no diameter.
      const found = findDbMotor(m.designation, undefined, undefined, m.manufacturerAbbrev)!;
      const pick = defaultDelay(found) ?? 'auto';
      const read = rktEveryDelay(m.designation, m.manufacturerAbbrev);
      if (pick === 'auto') {
        auto++;
        const finite = delayOptions(found).filter((d) => Number.isFinite(d));
        expect(read, m.motorId).toEqual({ delay: finite[finite.length - 1] ?? 0, autoDelay: true });
      } else {
        expect(read, m.motorId).toEqual({ delay: pick });
      }
    }
    // KBA G135R, G82W, H130W, H225R ("M") and K400S ("S,M,L") at the 2026-09-22 catalogue.
    expect(auto).toBeGreaterThan(0);
    expect(rktEveryDelay('ZQ9999X', 'Estes')).toBeNull();
  });

  /**
   * AUTO DELAY THROUGH A SAVE (seam review of audit 2026-09-22). The G135R the
   * reader loads on Auto flew 11 s on the Cheetah probe and deployed at
   * 0.87 m/s; saved, it went out as <EjectionDelay>0</EjectionDelay> and
   * reopened deploying at burnout, 250.9 m/s. Written back as −1, it reads back
   * on Auto. A motor that LISTS delays would read −1 back as its longest, so it
   * keeps its delay, and the Save says what the file cannot hold.
   */
  it('writes an Auto motor that lists no numeric delay back as −1, which reopens on Auto', async () => {
    const r = importRkt(rkt(['<EjectionDelay>-1.</EjectionDelay>'])
      .replace('<EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg>', '<EngineCode>G135R</EngineCode><EngineMfg>KBA</EngineMfg>'));
    const ref = Object.values(r.motors)[0]!;
    const loaded = (await matchImportedMotor(ref)).motor!;
    expect(loaded.meta.autoDelay).toBe(true);
    // What App's toExportMotor hands the writer for that primary, with no flight yet.
    const notes: string[] = [];
    const xml = exportRkt({
      name: 'Cheetah', tree: r.tree, notes,
      motors: { [ref.mountId!]: {
        designation: loaded.spec.designation, manufacturer: loaded.meta.orkManufacturer ?? loaded.meta.manufacturer,
        diameter: loaded.spec.diameter, length: loaded.spec.length, delay: loaded.spec.ejectionDelay,
        autoDelay: true, autoDelayFrom: 'provisional',
      } },
    });
    expect(xml).toContain('<EjectionDelay>-1</EjectionDelay>');
    expect(xml).toContain('<SimulationName>[G135R-*] </SimulationName>');
    expect(notes).toEqual([]);
    const again = Object.values(importRkt(xml).motors)[0]!;
    expect(again.autoDelay).toBe(true);
    expect((await matchImportedMotor(again)).motor!.meta.autoDelay).toBe(true);
  });

  it('keeps a listed-delay Auto motor’s delay — flown or provisional — and says so', () => {
    const r = importRkt(rkt(['<EjectionDelay>5.</EjectionDelay>']));
    const id = Object.values(r.motors)[0]!.mountId!;
    const c6 = (delay: number, autoDelayFrom: 'flown' | 'provisional'): OrkExportMotor => ({
      designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay, autoDelay: true, autoDelayFrom,
    });
    const flown: string[] = [];
    expect(exportRkt({ name: 'C', tree: r.tree, notes: flown, motors: { [id]: c6(5, 'flown') } }))
      .toContain('<EjectionDelay>5</EjectionDelay>');
    expect(flown).toEqual(['“C6” is on Auto (optimal) delay, which a .rkt has no setting for: it is saved at 5 s, '
      + 'the rounded optimum it flies on Auto, and reopens fixed at that.']);
    const provisional: string[] = [];
    expect(exportRkt({ name: 'C', tree: r.tree, notes: provisional, motors: { [id]: c6(7, 'provisional') } }))
      .toContain('<EjectionDelay>7</EjectionDelay>');
    expect(provisional).toEqual([expect.stringMatching(/no flight of the design as it stands says what Auto flies: it is saved at its provisional 7 s/)]);
    // A mount auto does not re-fly flies the delay in its field: nothing is lost, nothing is said.
    const other: string[] = [];
    exportRkt({ name: 'C', tree: r.tree, notes: other, motors: { [id]: { ...c6(7, 'provisional'), autoDelayFrom: undefined } } });
    expect(other).toEqual([]);
  });

  it('notes each motor once, however many mounts carry it', () => {
    // PELTZER_Swarm_JR.rkt: twelve E30 mounts, all −2, gave twelve identical lines.
    const r = importRkt(cluster('C6', 'Estes', '-2.'));
    expect(Object.values(r.motors)).toHaveLength(3);
    expect(r.notes.filter((n) => /plugged/.test(n)))
      .toEqual([expect.stringMatching(/^Motor C6 \(3 mounts\): plugged/)]);
  });

  it('an ordinary delay is untouched and adds no note', () => {
    const { delay, notes } = one('<EjectionDelay>5.</EjectionDelay>');
    expect(delay).toBe(5);
    expect(notes).not.toMatch(/EjectionDelay/);
  });

  it('reads the literal "Infinity" this app used to write as plugged, not as 0 s', () => {
    expect(one('<EjectionDelay>Infinity</EjectionDelay>').delay).toBe(Infinity);
  });

  it('notes a motor once, however many stored simulations repeat its engine set', () => {
    const r = importRkt(rkt(['<EjectionDelay>-2.</EjectionDelay>', '<EjectionDelay>-2.</EjectionDelay>']));
    expect(r.notes.filter((n) => /C6: plugged/.test(n))).toHaveLength(1);
  });

  it('exports a plugged motor as RockSim’s −2, never "Infinity", and re-imports it plugged', () => {
    // xmlNum read "Infinity" back as 0 s, so every chute on ejection deployed at burnout.
    const tree = {
      name: 'P',
      components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'mt', length: 0.3, outerRadius: 0.0124, thickness: 0.0004, motorMount: true },
      ] }] as ComponentNode[],
    };
    const xml = exportRkt({
      name: 'P', tree,
      motors: { mt: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: Infinity } },
    });
    expect(xml).toContain('<EjectionDelay>-2</EjectionDelay>');
    expect(xml).not.toMatch(/Infinity/);
    expect(Object.values(importRkt(xml).motors)[0]!.delay).toBe(Infinity);
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

  it('a HOLLOW nose linked to a solid catalogue row stays hollow (audit 2026-09-22)', async () => {
    // The desktop fixture's nose (ConstructionType 1, a 2.159 mm wall) re-badged as
    // Madcow's 2.6" fiberglass cone, which the catalogue marks solid. Before the
    // importer wrote `filled: false`, the link filled `true` onto it: 96.1 g →
    // 377.2 g through the kernel with the file's known mass switched off.
    const src = fixture('rocksimTestRocket1.rkt');
    const [head, rest] = src.split('<NoseCone>') as [string, string];
    const [block, tail] = rest.split('</NoseCone>') as [string, string];
    const b = block
      .replace(/<PartMfg>[^<]*<\/PartMfg>/, '<PartMfg>Madcow</PartMfg>')
      .replace(/<PartNo>[^<]*<\/PartNo>/, '<PartNo>2.6&quot; Fiberglass 5:1 Ogive Nose Cone</PartNo>');
    const r = importRkt(`${head}<NoseCone>${b}</NoseCone>${tail}`, { presets: await loadPresets() });
    const nose = r.tree.components[0]!.children![0]!;
    expect(nose['presetManufacturer']).toBe('Madcow'); // it DID link
    expect(nose['filled']).toBe(false);
    expect(r.notes.join(' ')).not.toMatch(/took[^;]*solid/);
    expect(r.notes.some((n) => /disagrees/.test(n) && /Nose cone: [^;]*solid/.test(n))).toBe(true);
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

  /*
   * Audit 2026-09-22 review: each <SimulationResults> keeps its own event
   * list, and only its MOTORS become the flight configuration. Shaped on
   * aerotech_warthog.rkt, whose simulation 1 (E15-4) deploys at the ejection
   * charge while the design's own list says 122 m — and nothing said so.
   */
  const withSim = (design: string, simEvents: string) => evXml(design)
    .replace('<Len>500.</Len>', '<Len>500.</Len><IsMotorMount>1</IsMotorMount>')
    .replace('</RocketDesign></DesignInformation>', '</RocketDesign></DesignInformation>'
      + '<SimulationResultsList><SimulationResults><SimulationName>[F26FJ-6] </SimulationName>'
      + `<SimulationEventList>${simEvents}</SimulationEventList><Stage3Engines><EngineSet>`
      + '<EngineCode>F26FJ</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo>'
      + '<EjectionDelay>6.</EjectionDelay></EngineSet></Stage3Engines></SimulationResults></SimulationResultsList>');

  it('says when the simulation opened stored other triggers, and keeps the design’s', () => {
    const { r, main, drogue } = chutes(withSim(ev(12, 5, 152.4) + ev(13, 4), ev(0, 0) + ev(12, 1) + ev(13, 4)));
    expect(r.chosenConfigId).toBe('rocksim-sim-1');
    expect(main['deployEvent']).toBe('altitude');
    expect(main['deployAltitude']).toBeCloseTo(152.4, 6);
    expect(drogue['deployEvent']).toBe('apogee');
    const note = r.notes.find((n) => /stored different recovery triggers/.test(n));
    expect(note).toMatch(/^Simulation 1 \(“\[F26FJ-6\]”\) stored different recovery triggers from the ones read above: Main at the ejection charge\. /);
    expect(note).not.toMatch(/Drogue/);
  });

  it('adds no such note when the simulation stored the design’s own triggers', () => {
    const { r } = chutes(withSim(ev(12, 5, 152.4) + ev(13, 4), ev(12, 5, 152.4) + ev(13, 4)));
    expect(r.chosenConfigId).toBe('rocksim-sim-1');
    expect(r.notes.some((n) => /stored different recovery triggers/.test(n))).toBe(false);
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
 * Format-audit row 16 — a parachute's SHROUD LINES have their own material, in
 * their own pair of tags, and we read neither. The chute was billed the
 * kernel's default line density instead of the one the file states.
 *
 * Desktop reads it (ParachuteHandler.java:100-103) and writes it
 * (ParachuteDTO.java:56-63). Despite the tag name the value is kg/m, not
 * kg/mm: ROCKSIM_TO_OPENROCKET_LINE_DENSITY = 1
 * (RockSimCommonConstants.java:116), and the arithmetic agrees — kg/mm would
 * make TubeFins2's six 0.61 m lines weigh 1.2 kg.
 *
 * Measured across the corpus: 15 of the 16 parachutes carry the tag. Where the
 * chute also states a KnownMass the override hid the error in the rocket's
 * total (4in WM Extreme, 2,4-D, Level 3, test01, vb38 — all 0 g); where it does
 * not, the mass really moves — SS Wild Bash 8.15 g over six chutes, Mach 3
 * 3.17 g, and the small TubeFins2 5.38 g, which is 4.0 % of its dry mass.
 */
describe('RockSim shroud-line density (audit row 16)', () => {
  it('reads the file’s own line density and material', () => {
    const r = importRkt(fixture('rocksimTestRocket2.rkt'));
    const chute = flatten(r.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['lineDensity']).toBeCloseTo(0.00032972, 12);
    expect(chute['lineMaterialName']).toBe('Carpet String (Apogee 29500)');
    // 16 lines x 1.35 m at that density is 7.12 g of line — a plausible number,
    // and the check that the units are kg/m and not kg/mm.
    const lines = (chute['lineCount'] as number) * (chute['lineLength'] as number);
    expect(lines).toBeCloseTo(21.6, 9);
    expect(lines * (chute['lineDensity'] as number)).toBeCloseTo(0.007122, 6);
  });

  it('removes the phantom mass the kernel default was billing', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const r = importRkt(fixture('TubeFins2.rkt'));
    const dry = (t: typeof r.tree): number => {
      resetEngine();
      return OrkRocket.buildTree(engineTree(t)).staticInfo().massEmpty;
    };
    // The pre-v0.113 import, reconstructed by dropping what it never read.
    const stripped = {
      ...r.tree,
      components: r.tree.components.map(function strip(n: ComponentNode): ComponentNode {
        const c = { ...n } as Record<string, unknown>;
        if (n.type === 'parachute') { delete c['lineDensity']; delete c['lineMaterialName']; }
        if (n.children) c['children'] = (n.children as ComponentNode[]).map(strip);
        return c as unknown as ComponentNode;
      }),
    };
    const before = dry(stripped);
    const after = dry(r.tree);
    expect(before - after).toBeCloseTo(0.005378, 5);
    // Heavy, not light: the default was billing mass no part of this rocket has.
    expect(after).toBeLessThan(before);
    expect((before - after) / after).toBeGreaterThan(0.04);
  });

  it('exports both tags so RockSim does not get weightless lines', () => {
    const r = importRkt(fixture('rocksimTestRocket2.rkt'));
    const xml = exportRkt({ name: 'RT', tree: r.tree });
    const chute = xml.split('<Parachute>')[1]!.split('</Parachute>')[0]!;
    expect(Number(/<ShroudLineMassPerMM>([^<]*)</.exec(chute)![1]))
      .toBeCloseTo(0.00032972, 12);
    expect(chute).toContain('<ShroudLineMaterial>Carpet String (Apogee 29500)</ShroudLineMaterial>');
    // ...and it survives a round trip.
    const back = flatten(importRkt(xml).tree.components).find((c) => c.type === 'parachute')!;
    expect(back['lineDensity']).toBeCloseTo(0.00032972, 12);
    expect(back['lineMaterialName']).toBe('Carpet String (Apogee 29500)');
  });

  it('writes nothing when the design states no line density', () => {
    // Inventing one would hand RockSim a number no part of the design carries.
    const xml = exportRkt({
      name: 'Bare',
      tree: {
        name: 'Bare',
        components: [{
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'bodytube' as const, id: 'b', length: 0.5, outerRadius: 0.03, thickness: 0.001,
              children: [{ type: 'parachute' as const, id: 'p', diameter: 0.6, lineCount: 6 }] },
          ],
        }],
      },
    });
    const chute = xml.split('<Parachute>')[1]!.split('</Parachute>')[0]!;
    expect(chute).not.toContain('<ShroudLineMassPerMM>');
    expect(chute).not.toContain('<ShroudLineMaterial>');
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
    // FORE end (MassCalculation.java:463-464), so the pin is the component's length.
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
    // Both on the component's CG, half its 20 mm length in (audit 2026-09-22 —
    // they were on its fore end, 200 and 100): TOP 200 + 10, and BOTTOM, which
    // RockSim counts forward from the parent's rear, 100 to the aft end + 10.
    expect(blocks[0]).toContain('<KnownCG>210</KnownCG>');
    expect(blocks[0]).toContain('<Xb>210</Xb>');
    expect(blocks[1]).toContain('<KnownCG>110</KnownCG>');
    expect(blocks[1]).toContain('<Xb>110</Xb>');
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

/**
 * Audit 2026-09-22, rows 383 and 384 — where the .rkt export puts things.
 *
 * 383: RockSim reads a <MassObject> as a POINT at <Xb> (and this app's importer
 * pins it there), so the point has to be the part's CG. It was written at the
 * part's FORE end, so a 150 mm av bay reached RockSim, and this app on re-open,
 * 75 mm forward of where it sits.
 *
 * 384: a cluster's copies 2..N and a pod set's instances 2..N were positioned
 * against whatever parent the previous copy's children left behind, so "middle
 * of parent" resolved against the wrong part.
 */
describe('.rkt export positions (audit 2026-09-22)', () => {
  const stage = (children: ComponentNode[]) => ({
    name: 'P',
    tree: { name: 'P', components: [{ type: 'stage', id: 's', children: [
      { type: 'bodytube', id: 'b', length: 0.4, outerRadius: 0.025, thickness: 0.001, children },
    ] }] as ComponentNode[] },
  });
  const blocks = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')) ?? [];
  const xbOf = (block: string) => Number(/<Xb>([^<]*)<\/Xb>/.exec(block)![1]);

  it('writes a mass component at its CG, for every position method', () => {
    const xml = exportRkt(stage([
      { type: 'masscomponent', id: 'top', mass: 0.25, length: 0.15, position: { method: 'top', offset: 0.1 } },
      { type: 'masscomponent', id: 'bot', mass: 0.25, length: 0.15, position: { method: 'bottom', offset: -0.05 } },
      { type: 'masscomponent', id: 'mid', mass: 0.25, length: 0.15, position: { method: 'middle', offset: 0.01 } },
      // A stated CG (from the component's own front) is where the point goes.
      { type: 'masscomponent', id: 'pin', mass: 0.25, length: 0.15, overrideCGX: 0.03,
        position: { method: 'top', offset: 0.2 } },
    ] as ComponentNode[]));
    const [top, bot, mid, pin] = blocks(xml, 'MassObject');
    // top: front 100 mm + half of 150.
    expect(xbOf(top!)).toBeCloseTo(175, 9);
    // bottom (RockSim measures forward from the parent's rear): aft end 50 mm
    // forward, CG a further 75.
    expect(xbOf(bot!)).toBeCloseTo(125, 9);
    // middle: front at 10 + (400 − 150)/2 = 135 mm, CG at 210.
    expect(xbOf(mid!)).toBeCloseTo(210, 9);
    expect(xbOf(pin!)).toBeCloseTo(230, 9);
    for (const b of [top!, bot!, mid!, pin!]) {
      expect(b).toContain(`<KnownCG>${xbOf(b)}</KnownCG>`);
    }
  });

  it('prefers the kernel CG it is handed, as a fairing needs', () => {
    // A shroud with one streamlined end has its CG off centre; compInfo carries it.
    const xml = exportRkt({
      ...stage([{ type: 'fairing', id: 'f', mass: 0.03, length: 0.08, position: { method: 'top', offset: 0.1 } }] as ComponentNode[]),
      compInfo: { f: { mass: 0.03, cgX: 0.035 } },
    });
    expect(xbOf(blocks(xml, 'MassObject')[0]!)).toBeCloseTo(135, 9);
  });

  it('round-trips a mass component with its CG where it was', () => {
    const d = stage([{ type: 'masscomponent', id: 'bay', name: 'Av bay', mass: 0.25, length: 0.15,
      position: { method: 'top', offset: 0.1 } }] as ComponentNode[]);
    const back = importRkt(exportRkt(d));
    const bay = flatten(back.tree.components).find((c) => c.type === 'masscomponent')!;
    const cgFromParentFront = (bay.position!.offset) + (bay['overrideCGX'] as number);
    expect(cgFromParentFront).toBeCloseTo(0.175, 9);
    expect(bay['mass']).toBeCloseTo(0.25, 9);
  });

  it('positions every cluster copy against the cluster’s own parent', () => {
    // An engine block inside the mount is what used to leave the stale parent.
    const d = stage([{ type: 'innertube', id: 'mt', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, cluster: 'double', clusterScale: 1, position: { method: 'middle', offset: 0 },
      children: [{ type: 'engineblock', id: 'eb', length: 0.005 }] }] as ComponentNode[]);
    const xml = exportRkt(d);
    // Blocks nest, so pick each copy out by its own <Name>. Before the fix,
    // copy 2 was centred in the ENGINE BLOCK'S parent (the mount itself):
    // (70 − 70)/2 = 0, and on re-open the two no longer grouped.
    const inner = xml.split('<BodyTube>').filter((b) => /<Name>Inner Tube/.test(b));
    expect(inner).toHaveLength(2);
    for (const b of inner) expect(xbOf(b)).toBeCloseTo(165, 9); // (400 − 70)/2
    const back = importRkt(xml);
    const mounts = flatten(back.tree.components).filter((c) => c.type === 'innertube');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!['cluster']).toBe('double');
    expect(back.notes.some((n) => /centerline tubes/.test(n))).toBe(false);
  });

  it('positions every pod instance against the pod set’s own parent', () => {
    const d = stage([{ type: 'podset', id: 'pods', instanceCount: 2, radiusMethod: 'free', radiusOffset: 0.05,
      position: { method: 'middle', offset: 0 },
      children: [{ type: 'bodytube', id: 'pt', length: 0.1, outerRadius: 0.01, thickness: 0.0005 }] }] as ComponentNode[]);
    const back = importRkt(exportRkt(d));
    const pods = flatten(back.tree.components).filter((c) => c.type === 'podset');
    expect(pods).toHaveLength(2);
    // The pod set has no axial length, so "middle" is the parent's midpoint.
    for (const p of pods) expect(p.position?.offset).toBeCloseTo(0.2, 9);
  });
});

/**
 * Audit 2026-09-22 row 395 — where the motors go. Every RockSim-written file in
 * the 939-file corpus that carries a motor (676 of the 843 readable ones) keeps
 * its <EngineSet>s inside RockSimDocument > SimulationResultsList >
 * SimulationResults, after </DesignInformation>, with all three <StageNEngines>
 * present; none puts them under <RocketDesign>, which is where this exporter did.
 */
describe('.rkt export writes its motors where RockSim keeps them', () => {
  const d = {
    name: 'M',
    tree: { name: 'M', components: [
      { type: 'stage', id: 's0', children: [
        { type: 'bodytube', id: 'm0', length: 0.2, outerRadius: 0.012, thickness: 0.0004, motorMount: true },
      ] },
      { type: 'stage', id: 's1', children: [
        { type: 'bodytube', id: 'm1', length: 0.2, outerRadius: 0.012, thickness: 0.0004, motorMount: true },
      ] },
    ] as ComponentNode[] },
    motors: {
      m0: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 5,
        ignitionEvent: 'burnout', ignitionDelay: 0 },
      m1: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 0 },
    },
  };

  it('puts the engine sets in one SimulationResults after DesignInformation, never in RocketDesign', () => {
    const xml = exportRkt(d);
    const design = xml.slice(xml.indexOf('<RocketDesign>'), xml.indexOf('</RocketDesign>'));
    expect(design).not.toContain('<EngineSet>');
    expect(design).not.toMatch(/<Stage\dEngines>/);
    const list = xml.slice(xml.indexOf('</DesignInformation>'));
    expect(list).toMatch(/^<\/DesignInformation>\n<SimulationResultsList>\n<SimulationResults>/);
    expect(list.match(/<SimulationResults>/g)).toHaveLength(1);
    // All three, in RockSim's order; the empty third slot too.
    const i1 = list.indexOf('<Stage1Engines>');
    const i2 = list.indexOf('<Stage2Engines>');
    const i3 = list.indexOf('<Stage3Engines>');
    expect(i1).toBeGreaterThan(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(list).toContain('<Stage1Engines>\n</Stage1Engines>');
    expect(xml.trimEnd().endsWith('</SimulationResultsList>\n</RockSimDocument>')).toBe(true);
  });

  it('names the simulation as RockSim does: the pad stage first, a cluster in one bracket', () => {
    // Loadstar's "[B6-0] [A8-5] " is its B6 booster under the A8 sustainer —
    // all 129 corpus names spelled this way for two or more stages put the
    // bottom stage first. This wrote the sustainer's first, a bracket per motor.
    expect(exportRkt(d)).toContain('<SimulationName>[C6-0] [C6-5] </SimulationName>');
    const cluster = {
      ...d,
      tree: { name: 'M', components: [{ ...d.tree.components[0]!, children: [
        { ...d.tree.components[0]!.children![0]!, children: [
          { type: 'innertube', id: 'm2', length: 0.07, outerRadius: 0.0065, thickness: 0.0004, motorMount: true },
        ] },
      ] }, d.tree.components[1]!] as ComponentNode[] },
      motors: { ...d.motors,
        m2: { designation: 'A10T', manufacturer: 'Estes', diameter: 0.013, length: 0.045, delay: 3,
          ignitionEvent: 'burnout', ignitionDelay: 0.5 } },
    };
    expect(exportRkt(cluster)).toContain('<SimulationName>[C6-0] [C6-5, A10T-3-0.5] </SimulationName>');
  });

  it('writes each engine set in RockSim’s own field order', () => {
    const set = /<EngineSet>([^]*?)<\/EngineSet>/.exec(exportRkt(d))![1]!;
    const tags = [...set.matchAll(/<(\w+)>/g)].map((m) => m[1]);
    expect(tags).toEqual(['EngineCount', 'EngineCode', 'IgnitionDelay', 'EngineMfg', 'MountSerialNo', 'EjectionDelay']);
  });

  it('re-opens with the same motors, stages and staging', () => {
    const back = importRkt(exportRkt(d));
    const refs = Object.values(back.motors);
    expect(refs).toHaveLength(2);
    const upper = refs.find((r) => r.ignitionEvent === 'burnout')!;
    expect(upper.delay).toBe(5);
    expect(refs.find((r) => r !== upper)!.delay).toBe(0);
  });

  it('writes no simulation block for a design with no motor', () => {
    const xml = exportRkt({ ...d, motors: {} });
    expect(xml).not.toContain('<SimulationResults');
    expect(xml).not.toContain('<EngineSet>');
  });
});

/**
 * Audit 2026-09-22 row 382 — a .rkt carries one motor set PER STORED
 * SIMULATION, and they disagree (581 of the 600 corpus files with more than
 * one engine-bearing simulation). Every <EngineSet> in the file used to be
 * merged into one map, the last simulation to name a mount winning:
 * Estes/Loadstar.rkt (11 simulations) opened as a B6 booster under a B4
 * sustainer, a pairing none of its simulations flies, and nothing said which
 * simulation was used. Shaped on Loadstar: sustainer mount serial 7, booster 14.
 */
describe('.rkt simulations become flight configurations', () => {
  type Eng = { slot: 2 | 3; code: string; delay: number };
  const sim = (name: string, engines: Eng[]) => `<SimulationResults><SimulationName>${name}</SimulationName>
      <Stage1Engines></Stage1Engines>
      ${[2, 3].map((slot) => `<Stage${slot}Engines>${engines.filter((e) => e.slot === slot).map((e) =>
        `<EngineSet><EngineCount>1</EngineCount><EngineCode>${e.code}</EngineCode><IgnitionDelay>0.</IgnitionDelay>`
        + `<EngineMfg>Estes</EngineMfg><MountSerialNo>${e.slot === 3 ? 7 : 14}</MountSerialNo>`
        + `<EjectionDelay>${e.delay}.</EjectionDelay></EngineSet>`).join('')}</Stage${slot}Engines>`).join('')}
    </SimulationResults>`;
  const loadstar = (sims: string[]) => `<RockSimDocument><DesignInformation><RocketDesign>
    <Name>Loadstar</Name><StageCount>2</StageCount>
    <Stage3Parts><BodyTube><Name>Upper</Name><OD>24.8</OD><ID>24.1</ID><Len>200</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>7</SerialNo></BodyTube></Stage3Parts>
    <Stage2Parts><BodyTube><Name>Lower</Name><OD>24.8</OD><ID>24.1</ID><Len>150</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>14</SerialNo></BodyTube></Stage2Parts>
    </RocketDesign></DesignInformation>
    <SimulationResultsList>${sims.join('')}</SimulationResultsList></RockSimDocument>`;
  const LOADSTAR = loadstar([
    sim('[A8-0] [A8-5] ', [{ slot: 2, code: 'A8', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
    sim('[B6-0] [A8-5] ', [{ slot: 2, code: 'B6', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
    sim('[B6-0] [B6-6] ', [{ slot: 2, code: 'B6', delay: 0 }, { slot: 3, code: 'B6', delay: 6 }]),
    sim('[B6-6] ', [{ slot: 3, code: 'B6', delay: 6 }]),
    sim('[B6-6] ', [{ slot: 3, code: 'B6', delay: 6 }]),
    sim('[B4-4] ', [{ slot: 3, code: 'B4', delay: 4 }]),
  ]);
  const byStage = (r: ReturnType<typeof importRkt>, motors: Record<string, { designation: string; delay: number }>) => {
    const [sus, boo] = r.tree.components.map((s) => s.children![0]!.id!);
    return [boo ? motors[boo]?.designation : undefined, motors[sus!]?.designation];
  };

  it('opens ONE simulation’s motors, never a mix of several', () => {
    const r = importRkt(LOADSTAR);
    // The old merge: B6 booster (last to name serial 14) under a B4 sustainer.
    expect(byStage(r, r.motors)).toEqual(['A8', 'A8']);
    expect(r.chosenConfigId).toBe(r.configs[0]!.id);
    expect(Object.values(r.motors).map((m) => m.delay).sort()).toEqual([0, 5]);
  });

  it('keeps every distinct motor set as a configuration, repeats folded, in file order', () => {
    const r = importRkt(LOADSTAR);
    // Ids by the simulation each came from — the sixth, a repeat of the fourth, folds away.
    expect(r.configs.map((c) => c.id)).toEqual(
      ['rocksim-sim-1', 'rocksim-sim-2', 'rocksim-sim-3', 'rocksim-sim-4', 'rocksim-sim-6']);
    // RockSim's own motor-derived names are not kept: they would go stale on the
    // first motor change, where configLabel's live one does not.
    expect(r.configs.map((c) => c.name)).toEqual([null, null, null, null, null]);
    expect(r.configs.map((c) => byStage(r, c.motors))).toEqual(
      [['A8', 'A8'], ['B6', 'A8'], ['B6', 'B6'], [undefined, 'B6'], [undefined, 'B4']]);
    expect(r.configs.filter((c) => c.isDefault)).toHaveLength(1);
    expect(r.configs[0]!.isDefault).toBe(true);
  });

  it('keeps a simulation name the user typed in RockSim', () => {
    const r = importRkt(loadstar([
      sim('Club launch, calm', [{ slot: 2, code: 'A8', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
      sim('[B6-0] [A8-5] ', [{ slot: 2, code: 'B6', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
    ]));
    expect(r.configs.map((c) => c.name)).toEqual(['Club launch, calm', null]);
  });

  it('says which simulation was opened', () => {
    const note = importRkt(LOADSTAR).notes.find((n) => /RockSim simulations/.test(n));
    expect(note).toMatch(/6 RockSim simulations with motors/);
    expect(note).toMatch(/5 different motor sets/);
    expect(note).toMatch(/Simulation 1 \(“\[A8-0\] \[A8-5\]”\) was opened/);
  });

  it('lights a sustainer-only simulation at launch, so its configuration can fly', () => {
    // The upper stage's 'burnout' waits on a booster that never burns — the
    // kernel aborts "no motors ignited" (the same trap importCdx1 closed).
    const r = importRkt(LOADSTAR);
    const b4 = Object.values(r.configs[4]!.motors)[0]!;
    expect(b4.ignitionEvent).toBe('launch');
    expect(b4.ignitionDelay).toBe(0);
    // A full stack keeps the burnout timer on the upper stage.
    const [sus] = r.tree.components.map((s) => s.children![0]!.id!);
    expect(r.configs[0]!.motors[sus!]!.ignitionEvent).toBe('burnout');
  });

  /*
   * Shaped on Scratch Builds/Blackhawk_2-stage.rkt: StageCount 2 with the
   * booster slot EMPTY, and its one simulation lighting two O5500X on the
   * sustainer, one with IgnitionDelay 15. RockSim's stored TimeToBurnout for it
   * is 18.9975 s — 15 s after launch plus the motor's burn — so RockSim flew
   * that delay from launch. The first re-keying zeroed it and lit both at liftoff.
   */
  const BLACKHAWK = `<RockSimDocument><DesignInformation><RocketDesign>
    <Name>Blackhawk</Name><StageCount>2</StageCount>
    <Stage3Parts><BodyTube><Name>Body</Name><OD>203</OD><ID>200</ID><Len>2000</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>2</SerialNo><AttachedParts>
      <BodyTube><Name>Outboard mount</Name><OD>100</OD><ID>98</ID><Len>900</Len><RadialLoc>50</RadialLoc>
        <IsMotorMount>1</IsMotorMount><SerialNo>14</SerialNo></BodyTube>
      </AttachedParts></BodyTube></Stage3Parts>
    <Stage2Parts></Stage2Parts><Stage1Parts></Stage1Parts>
    </RocketDesign></DesignInformation>
    <SimulationResultsList><SimulationResults><SimulationName>[O5500X-0-15, O5500X-0] </SimulationName>
      <Stage1Engines></Stage1Engines><Stage2Engines></Stage2Engines><Stage3Engines>
      <EngineSet><EngineCount>1</EngineCount><EngineCode>O5500X</EngineCode><IgnitionDelay>15.</IgnitionDelay>
        <EngineMfg>AeroTech</EngineMfg><MountSerialNo>2</MountSerialNo><EjectionDelay>0.</EjectionDelay></EngineSet>
      <EngineSet><EngineCount>1</EngineCount><EngineCode>O5500X</EngineCode><IgnitionDelay>0.</IgnitionDelay>
        <EngineMfg>AeroTech</EngineMfg><MountSerialNo>14</MountSerialNo><EjectionDelay>0.</EjectionDelay></EngineSet>
      </Stage3Engines></SimulationResults></SimulationResultsList></RockSimDocument>`;

  it('keeps a re-keyed stage’s IgnitionDelay, counted from launch', () => {
    const r = importRkt(BLACKHAWK);
    expect(r.tree.components).toHaveLength(2);
    const body = r.tree.components[0]!.children![0]!;
    const outboard = body.children!.find((c) => c.name === 'Outboard mount')!;
    expect(r.motors[body.id!]).toMatchObject({ ignitionEvent: 'launch', ignitionDelay: 15 });
    expect(r.motors[outboard.id!]).toMatchObject({ ignitionEvent: 'launch', ignitionDelay: 0 });
    expect(r.notes.join(' ')).toMatch(/was opened with its lowest stage's motors timed from launch/);
  });

  it('writes that delay back, so the .rkt round trip keeps it', () => {
    const r = importRkt(BLACKHAWK);
    const xml = exportRkt({ name: 'Blackhawk', tree: r.tree, motors: r.motors });
    expect(xml).toContain('<SimulationName>[O5500X-0-15, O5500X-0] </SimulationName>');
    const back = importRkt(xml);
    expect(Object.values(back.motors).map((m) => [m.ignitionEvent, m.ignitionDelay]).sort())
      .toEqual([['launch', 0], ['launch', 15]]);
  });

  it('opens the first simulation that motors the launch stage, and says why', () => {
    const r = importRkt(loadstar([
      sim('[B4-4] ', [{ slot: 3, code: 'B4', delay: 4 }]),
      sim('[B6-0] [A8-5] ', [{ slot: 2, code: 'B6', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
    ]));
    expect(byStage(r, r.motors)).toEqual(['B6', 'A8']);
    expect(r.chosenConfigId).toBe(r.configs[1]!.id);
    expect(r.notes.join(' ')).toMatch(/Simulation 1 \(“\[B4-4\]”\) in this file puts no motor on the launch stage/);
    expect(r.notes.join(' ')).toMatch(/Simulation 2 \(“\[B6-0\] \[A8-5\]”\) was opened instead/);
  });

  it('adds no note, and one configuration, when every simulation flies the same motors', () => {
    const r = importRkt(loadstar([
      sim('[A8-0] [A8-5] ', [{ slot: 2, code: 'A8', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
      sim('[A8-0] [A8-5] ', [{ slot: 2, code: 'A8', delay: 0 }, { slot: 3, code: 'A8', delay: 5 }]),
    ]));
    expect(r.configs).toHaveLength(1);
    expect(r.notes.some((n) => /RockSim simulations/.test(n))).toBe(false);
  });

  it('reads engine sets written outside any simulation (this app’s own exports before the fix)', () => {
    const xml = loadstar([]).replace('</Stage2Parts>', '</Stage2Parts><Stage3Engines><EngineSet>'
      + '<EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg><MountSerialNo>7</MountSerialNo>'
      + '<EjectionDelay>5</EjectionDelay><IgnitionDelay>0</IgnitionDelay></EngineSet></Stage3Engines>'
      + '<Stage2Engines><EngineSet><EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg>'
      + '<MountSerialNo>14</MountSerialNo><EjectionDelay>0</EjectionDelay></EngineSet></Stage2Engines>');
    const r = importRkt(xml);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.name).toBeNull();
    expect(byStage(r, r.motors)).toEqual(['C6', 'C6']);
  });
});

/**
 * CLUSTERS, POD SETS AND OFF-AXIS TUBES THROUGH A .rkt AND BACK (seam review
 * of audit 2026-09-22). Three seams met here. The writer split a cluster into
 * N motor-mount tubes and wrote ONE engine set, on the first — where RockSim
 * lists a set per tube (every corpus set is EngineCount 1) — so the file flew
 * one motor. The reader's regrouping hid that for an on-axis cluster, and
 * could not once the writer put an off-axis cluster's tubes where the kernel
 * flies them: they came back as N centreline mounts carrying one motor. And a
 * lone off-axis tube came back on the axis, while identical tubes carrying
 * DIFFERENT motors were merged into one cluster flying one of them.
 */
describe('.rkt clusters and off-axis tubes round-trip: count, place, motors', () => {
  const tubeIn = (tube: Record<string, unknown>) => ({
    name: 'C', tree: {
      name: 'C',
      components: [{
        type: 'stage', id: 's', name: 'Sustainer',
        children: [{
          type: 'bodytube', id: 'b', name: 'Body', length: 0.3, outerRadius: 0.05, thickness: 0.001,
          children: [{ type: 'innertube', id: 'm', name: 'Mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, ...tube }],
        }],
      }] as ComponentNode[],
    },
  });
  const D12: OrkExportMotor = { designation: 'D12', manufacturer: 'Estes', diameter: 0.024, length: 0.07, delay: 5 };
  /** Every inside tube's centre, (y, z) in metres, sorted — from RadialLoc (mm) and RadialAngle (rad). */
  const centres = (xml: string) => [...xml.matchAll(
    /<IsInsideTube>1<\/IsInsideTube>\s*<RadialLoc>([^<]+)<\/RadialLoc>\s*<RadialAngle>([^<]+)<\/RadialAngle>/g)]
    .map((m) => [(Number(m[1]) / 1000) * Math.cos(Number(m[2])), (Number(m[1]) / 1000) * Math.sin(Number(m[2]))] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const mountsOf = (tree: { components: ComponentNode[] }) => flatten(tree.components).filter((n) => n['motorMount'] === true);

  it('writes one engine set per tube and one name entry per motor, as RockSim writes a cluster', () => {
    const xml = exportRkt({ ...tubeIn({ motorMount: true, cluster: '3-ring' }), motors: { m: D12 } });
    expect((xml.match(/<IsInsideTube>1<\/IsInsideTube>/g) ?? []).length).toBe(3);
    const sets = [...xml.matchAll(/<EngineSet>[\s\S]*?<MountSerialNo>(\d+)<\/MountSerialNo>[\s\S]*?<\/EngineSet>/g)].map((m) => m[1]);
    expect(sets).toHaveLength(3);
    expect(new Set(sets).size).toBe(3);
    expect(xml).toContain('<SimulationName>[D12-5, D12-5, D12-5] </SimulationName>');
    expect((xml.match(/<EngineCount>1<\/EngineCount>/g) ?? []).length).toBe(3);
  });

  it('brings an off-axis, turned cluster back as ONE cluster, where it was, carrying every motor', () => {
    const design = tubeIn({
      motorMount: true, cluster: '3-ring', clusterRotation: Math.PI / 6,
      radialDirection: (20 * Math.PI) / 180, radialPosition: 0.006,
    });
    const first = exportRkt({ ...design, motors: { m: D12 } });
    const back = importRkt(first);
    const mounts = mountsOf(back.tree);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!['cluster']).toBe('3-ring');
    expect(mounts[0]!['radialPosition']).toBeCloseTo(0.006, 9);
    // Its motor rides the cluster: three motors, as the design flew.
    expect(Object.keys(back.motors)).toEqual([mounts[0]!.id]);
    expect(back.notes.join('\n')).toMatch(/imported as one 3-ring cluster, 6\.0 mm off the centerline/);
    // And every tube where the kernel put it: written again, the same three centres.
    const again = exportRkt({ name: 'C', tree: back.tree, motors: { [mounts[0]!.id!]: D12 } });
    const [a, b] = [centres(first), centres(again)];
    expect(b).toHaveLength(3);
    b.forEach((c, i) => { expect(c[0]).toBeCloseTo(a[i]![0], 9); expect(c[1]).toBeCloseTo(a[i]![1], 9); });
  });

  it('brings a lone tube back off the axis, where it was', () => {
    const back = importRkt(exportRkt(tubeIn({ radialPosition: 0.012, radialDirection: (50 * Math.PI) / 180 })));
    const tube = flatten(back.tree.components).find((n) => n.type === 'innertube')!;
    expect(tube['radialPosition']).toBeCloseTo(0.012, 9);
    expect(tube['radialDirection']).toBeCloseTo((50 * Math.PI) / 180, 9);
    expect(back.notes.join('\n')).not.toMatch(/cluster|centerline/i);
  });

  it('gives a pod set’s every instance its motor', () => {
    const tree = {
      name: 'P',
      components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
        { type: 'bodytube', id: 'b', name: 'Body', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'podset', id: 'pods', instanceCount: 2, radiusOffset: 0.05, children: [
            { type: 'bodytube', id: 'pt', name: 'Pod tube', length: 0.2, outerRadius: 0.012, thickness: 0.0005,
              motorMount: true },
          ] },
        ] },
      ] }] as ComponentNode[],
    };
    const xml = exportRkt({ name: 'P', tree, motors: { pt: D12 } });
    expect(xml).toContain('<SimulationName>[D12-5, D12-5] </SimulationName>');
    const back = importRkt(xml);
    expect(Object.values(back.motors).map((m) => m.designation)).toEqual(['D12', 'D12']);
  });

  /** Four identical tubes around the axis, and what each simulation loads in them — 8 in Goblin 4 x 75mm.rkt's shape. */
  const goblin = (sims: string[][], tubeXml: (i: number) => string = () => '') => `<RockSimDocument><DesignInformation><RocketDesign>
    <Name>Goblin-ish</Name><StageCount>1</StageCount>
    <Stage3Parts><BodyTube><Name>Body</Name><OD>203</OD><ID>199</ID><Len>1500</Len><SerialNo>1</SerialNo>
      <AttachedParts>${[0, 1, 2, 3].map((i) => `<BodyTube><Name>Tube ${i + 1}</Name><OD>79</OD><ID>76</ID><Len>600</Len>
        <IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount><SerialNo>${8 + i}</SerialNo>${tubeXml(i)}
        <RadialLoc>60</RadialLoc><RadialAngle>${(i * Math.PI) / 2}</RadialAngle></BodyTube>`).join('')}
      </AttachedParts></BodyTube></Stage3Parts>
    </RocketDesign></DesignInformation>
    <SimulationResultsList>${sims.map((codes) => `<SimulationResults><Stage3Engines>${codes.map((c, i) => (c ? `<EngineSet>
      <EngineCount>1</EngineCount><EngineCode>${c}</EngineCode><EngineMfg>AeroTech</EngineMfg><IgnitionDelay>0.</IgnitionDelay>
      <MountSerialNo>${8 + i}</MountSerialNo><EjectionDelay>-2.</EjectionDelay></EngineSet>` : '')).join('')}
    </Stage3Engines></SimulationResults>`).join('')}</SimulationResultsList></RockSimDocument>`;

  it('keeps identical tubes that carry different motors as mounts of their own', () => {
    const r = importRkt(goblin([
      ['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ'],
      ['M2050X', 'L1170FJ', 'M2050X', 'L1170FJ'],
      ['K1499N', '', 'K1499N', ''],
    ]));
    const mounts = mountsOf(r.tree);
    expect(mounts).toHaveLength(4);
    expect(mounts.every((m) => m['cluster'] === undefined)).toBe(true);
    // Each where the file puts it: 60 mm out, a quarter turn apart.
    expect(mounts.map((m) => m['radialPosition'] as number)).toEqual([0.06, 0.06, 0.06, 0.06].map((v) => expect.closeTo(v, 9)));
    const designations = (id: string) => Object.values(r.configs.find((c) => c.id === id)!.motors)
      .map((m) => m.designation).sort();
    expect(designations('rocksim-sim-1')).toEqual(['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ']);
    expect(designations('rocksim-sim-2')).toEqual(['L1170FJ', 'L1170FJ', 'M2050X', 'M2050X']);
    expect(designations('rocksim-sim-3')).toEqual(['K1499N', 'K1499N']);
    expect(r.notes.join('\n')).toMatch(/4 identical motor tubes in “Body” carry different motors in the file's simulations/);
    // The same tubes loaded alike in every simulation are still one cluster.
    const alike = importRkt(goblin([['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ'], ['K1499N', 'K1499N', 'K1499N', 'K1499N']]));
    expect(mountsOf(alike.tree).map((m) => m['cluster'])).toEqual(['4-ring']);
    expect(Object.values(alike.configs.find((c) => c.id === 'rocksim-sim-2')!.motors).map((m) => m.designation)).toEqual(['K1499N']);
  });

  /**
   * ONE TUBE'S MASS IS NOT THE CLUSTER'S (review of the seam fixes). A
   * RockSim <KnownMass> is its own tube's; the kernel's override on a cluster
   * tube is the WHOLE cluster's (MassCalculation.calculateStructure weighs it
   * at getOverrideMass(), where a computed mass is multiplied by the instance
   * count). Merged, four 441.75 g tubes — 8 in Goblin 4 x 75mm.rkt's — flew as
   * 441.75 g, 1,325 g light, while the same four kept apart flew all 1,767 g:
   * the rocket's weight hung on whether its simulations loaded the tubes alike.
   */
  const weighed = () => '<KnownMass>441.75</KnownMass><KnownCG>279.4</KnownCG><UseKnownCG>1</UseKnownCG>';
  it('weighs a merged cluster as every tube the file weighs — the same as the tubes kept apart', async () => {
    const merged = importRkt(goblin([['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ']], weighed));
    const apart = importRkt(goblin([['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ'], ['M2050X', 'L1170FJ', 'M2050X', 'L1170FJ']], weighed));
    const [cluster] = mountsOf(merged.tree);
    expect(cluster!['cluster']).toBe('4-ring');
    expect(cluster!['overrideMass']).toBeCloseTo(4 * 0.44175, 12);
    expect(cluster!['overrideCGX']).toBeCloseTo(0.2794, 12);
    expect(mountsOf(apart.tree).map((m) => m['overrideMass'])).toEqual(Array(4).fill(expect.closeTo(0.44175, 12)));
    expect(merged.notes).toContain('Cluster: 4 identical motor tubes in “Body” imported as one 4-ring cluster. '
      + 'Its mass is the 4 tube masses the file states, added together: 1767 g.');
    // The kernel's own sum agrees: the same rocket, whichever way it came in.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const dry = (t: typeof merged.tree): number => {
      resetEngine();
      return OrkRocket.buildTree(engineTree(t)).staticInfo().massEmpty;
    };
    expect(dry(merged.tree)).toBeCloseTo(dry(apart.tree), 9);
  }, 60000);

  it('keeps apart identical tubes the file weighs differently', () => {
    // One tube weighed, three computed: no single cluster mass says that.
    const r = importRkt(goblin([['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ']], (i) => (i === 0 ? weighed() : '')));
    const mounts = mountsOf(r.tree);
    expect(mounts).toHaveLength(4);
    expect(mounts.map((m) => m['overrideMass'])).toEqual([expect.closeTo(0.44175, 12), undefined, undefined, undefined]);
    expect(r.notes.join('\n')).toMatch(/4 identical motor tubes in “Body” are weighed differently in the file, so each stays a part of its own/);
    // Every tube weighed, at different balance points: apart too.
    const cgs = importRkt(goblin([['L1170FJ', 'L1170FJ', 'L1170FJ', 'L1170FJ']],
      (i) => `<KnownMass>441.75</KnownMass><KnownCG>${279.4 + i}</KnownCG><UseKnownCG>1</UseKnownCG>`));
    expect(mountsOf(cgs.tree)).toHaveLength(4);
  });

  it('writes each tube of a cluster its own share of the cluster’s mass, and reads the whole back', () => {
    const notes: string[] = [];
    const design = tubeIn({ motorMount: true, cluster: '3-ring', overrideMass: 0.3, overrideCGX: 0.035 });
    // The kernel's figures for the cluster tube: the whole cluster's, as componentInfo reports them.
    const xml = exportRkt({ ...design, notes, compInfo: { m: { mass: 0.3, cgX: 0.035 } } });
    const grams = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))].map((m) => Number(m[1]));
    // The body, then every copy at 100 g — RockSim's per-part mass — never the cluster's 300 g.
    expect(grams('KnownMass')).toEqual([0, 100, 100, 100].map((g) => expect.closeTo(g, 9)));
    expect(grams('CalcMass')).toEqual([100, 100, 100].map((g) => expect.closeTo(g, 9)));
    expect(notes).toEqual([]);
    const [back] = mountsOf(importRkt(xml).tree);
    expect(back!['cluster']).toBe('3-ring');
    expect(back!['overrideMass']).toBeCloseTo(0.3, 12);
  });

  /**
   * LEM-M2B.ork's two nose-cone tubes (not mounts, 12.954 mm at 0° and 12.7 mm
   * at 180°), written to a .rkt and read back: exactly a double cluster centred
   * 0.127 mm off the axis — and named as tubes, not as motor tubes.
   */
  it('fits two plain tubes about their own centre and does not call them motor tubes', () => {
    const tube = (angle: number, loc: number) => `<BodyTube><Name>Tube</Name><OD>4.7625</OD><ID>1.5875</ID><Len>25.4</Len>
      <IsInsideTube>1</IsInsideTube><RadialLoc>${loc}</RadialLoc><RadialAngle>${angle}</RadialAngle></BodyTube>`;
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>LEM</Name><StageCount>1</StageCount>
      <Stage3Parts><NoseCone><Name>Nose cone</Name><Len>100</Len><BaseDia>40</BaseDia>
        <AttachedParts>${tube(0, 12.954)}${tube(Math.PI, 12.7)}</AttachedParts></NoseCone></Stage3Parts>
      </RocketDesign></DesignInformation></RockSimDocument>`);
    const tubes = flatten(r.tree.components).filter((n) => n.type === 'innertube');
    expect(tubes).toHaveLength(1);
    expect(tubes[0]!['cluster']).toBe('double');
    expect(tubes[0]!['radialPosition']).toBeCloseTo(0.000127, 9);
    expect(r.notes.join('\n')).toContain('Cluster: 2 identical tubes in “Nose cone” imported as one double cluster, 0.1 mm off the centerline.');
  });

  /**
   * A tube holds one motor, so two engine sets naming ONE tube is a stale
   * serial — EclipseB_38mmRedlineEllis.rkt's H148R at 30 s and at 0 s, both on
   * serial 22, beside a twin tube carrying none. Merged, the pair flew as two
   * of the last; kept apart un-repaired it would fly one. The extra set goes to
   * the twin.
   */
  it('gives a set that names an already-loaded tube to its empty twin', () => {
    const tube = (serial: number, angle: number) => `<BodyTube><Name>Motor tube</Name><OD>41</OD><ID>38.5</ID><Len>300</Len>
      <IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount><SerialNo>${serial}</SerialNo>
      <RadialLoc>30</RadialLoc><RadialAngle>${angle}</RadialAngle></BodyTube>`;
    const set = (delay: string) => `<EngineSet><EngineCount>1</EngineCount><EngineCode>H148R</EngineCode>
      <EngineMfg>AeroTech</EngineMfg><IgnitionDelay>0.</IgnitionDelay><MountSerialNo>22</MountSerialNo>
      <EjectionDelay>${delay}</EjectionDelay></EngineSet>`;
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>Eclipse</Name><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><Name>Body</Name><OD>102</OD><ID>98</ID><Len>900</Len><SerialNo>1</SerialNo>
        <AttachedParts>${tube(22, 0)}${tube(23, Math.PI)}</AttachedParts></BodyTube></Stage3Parts>
      </RocketDesign></DesignInformation><SimulationResultsList><SimulationResults><Stage3Engines>
        ${set('30.')}${set('0.')}</Stage3Engines></SimulationResults></SimulationResultsList></RockSimDocument>`);
    const mounts = mountsOf(r.tree);
    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => r.motors[m.id!]?.delay)).toEqual([30, 0]);
  });

  const corpus = ['G:/Documents/Dropbox/Rocksim Designs', 'C:/Users/peltz/Dropbox/Rocksim Designs'];
  const ECLIPSE = corpus.map((c) => `${c}/Public Missiles/EclipseB_38mmRedlineEllis.rkt`).find((p) => existsSync(p));
  it.skipIf(!ECLIPSE)('EclipseB_38mmRedlineEllis.rkt: two tubes, two motors, each its own delay', () => {
    const r = importRkt(readFileSync(ECLIPSE!, 'latin1'));
    expect(Object.values(r.motors).map((m) => `${m.designation}-${m.delay}`).sort()).toEqual(['H148R-0', 'H148R-30']);
  });
  const GOBLIN = corpus.map((c) => `${c}/Wildman/PELTZER/8 in Goblin 4 x 75mm.rkt`).find((p) => existsSync(p));
  it.skipIf(!GOBLIN)('8 in Goblin 4 x 75mm.rkt: simulations 90 and 102 fly the motors RockSim flew', () => {
    const r = importRkt(readFileSync(GOBLIN!, 'latin1'));
    const sim = (n: number) => Object.values(r.configs.find((c) => c.id === `rocksim-sim-${n}`)!.motors)
      .map((m) => m.designation).sort();
    expect(sim(90)).toEqual(['L1170FJ', 'L1170FJ', 'M2050X', 'M2050X']);
    expect(sim(102)).toEqual(['K1499N', 'K1499N']);
  });
  const DARKSTAR = corpus.map((c) => `${c}/Scratch Builds/PELTZER - 12in Darkstar.rkt`).find((p) => existsSync(p));
  it.skipIf(!DARKSTAR)('PELTZER - 12in Darkstar.rkt: the six-tube cluster weighs all six 892 g tubes', () => {
    const r = importRkt(readFileSync(DARKSTAR!, 'latin1'));
    const cluster = mountsOf(r.tree).find((m) => m['cluster'] === '6-ring')!;
    expect(cluster['overrideMass']).toBeCloseTo(6 * 0.892, 12);
  });
});
