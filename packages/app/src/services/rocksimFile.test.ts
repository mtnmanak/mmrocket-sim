// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportRkt, importRkt } from './rocksimFile.js';

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

    const body = chain.find((c) => c.type === 'bodytube')!;
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
    const ff = flatten(r.tree.components).find((c) => c.type === 'freeformfinset')!;
    const pts = ff['points'] as [number, number][];
    // File: 60,0|50,30|25,35|0,0| → reversed (last point is 0,0) and ÷1000.
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]![0]).toBeCloseTo(0.06, 9);
    expect(pts.some(([, y]) => Math.abs(y - 0.035) < 1e-9)).toBe(true);
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
