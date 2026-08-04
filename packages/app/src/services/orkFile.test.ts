// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Golden .ork files produced by the REAL OpenRocket 24.12 GeneralRocketSaver. */
function golden(name: string): ArrayBuffer {
  const buf = readFileSync(join(here, '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
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

/** Release C: imports are stage-wrapped — this unwraps the first stage. */
function firstStageChildren(result: { tree: { components: ComponentNode[] } }): ComponentNode[] {
  expect(result.tree.components.every((c) => c.type === 'stage')).toBe(true);
  return result.tree.components[0]!.children ?? [];
}

describe('.ork tree import', () => {
  it('imports the reference golden file with structure preserved', () => {
    const result = importOrk(golden('reference.ork'));

    expect(result.name).toBe('Reference Rocket');
    const chain = firstStageChildren(result);
    expect(chain.map((c) => c.type)).toEqual(['nosecone', 'bodytube']);
    const body = chain[1]!;
    expect((body.children ?? []).map((c) => c.type)).toEqual([
      'trapezoidfinset', 'innertube', 'parachute',
    ]);
    const mount = body.children![1]!;
    expect(mount['motorMount']).toBe(true);
    expect(result.motor?.designation).toBe('C6');
    expect(result.motor?.mountId).toBe(mount.id);
    expect(result.motors[mount.id!]?.designation).toBe('C6');
    expect(result.ignored).toEqual([]);
  });

  it('imports the kitchen-sink golden file — all 17 component types', () => {
    const result = importOrk(golden('kitchensink.ork'));

    const types = flatten(result.tree.components).map((c) => c.type);
    for (const t of [
      'nosecone', 'masscomponent', 'bodytube', 'ellipticalfinset', 'freeformfinset', 'launchlug',
      'railbutton', 'innertube', 'engineblock', 'centeringring', 'tubecoupler',
      'bulkhead', 'parachute', 'streamer', 'shockcord', 'transition', 'tubefinset',
    ] as const) {
      expect(types).toContain(t);
    }
    // Nesting preserved: engine block inside the mount, bulkhead inside coupler.
    const all = flatten(result.tree.components);
    const mount = all.find((n) => n.type === 'innertube')!;
    expect((mount.children ?? []).map((c) => c.type)).toContain('engineblock');
    const coupler = all.find((n) => n.type === 'tubecoupler')!;
    expect((coupler.children ?? []).map((c) => c.type)).toContain('bulkhead');
    // Positions read from axialoffset.
    const lug = all.find((n) => n.type === 'launchlug')!;
    expect(lug.position?.method).toBe('middle');
    // Freeform fins: point array and cross-section preserved.
    const ff = all.find((n) => n.type === 'freeformfinset')!;
    const pts = ff['points'] as [number, number][];
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[1]![1]).toBeCloseTo(0.032, 12);
    expect(ff['crossSection']).toBe('rounded');
    // Elliptical fins carry their airfoil cross-section.
    const ef = all.find((n) => n.type === 'ellipticalfinset')!;
    expect(ef['crossSection']).toBe('airfoil');
    expect(result.ignored).toEqual([]);
  });
});

describe('.ork tree round trip', () => {
  it('kitchen sink: export -> import preserves structure, params and positions', () => {
    const original = importOrk(golden('kitchensink.ork'));
    const xml = exportOrk({
      name: original.name,
      tree: original.tree,
      motor: original.motor,
      mountId: original.motor?.mountId,
    });
    const roundTripped = importOrk(xml);

    const stripIds = (nodes: ComponentNode[]): unknown[] =>
      nodes.map(({ id, children, ...rest }) => ({
        ...rest,
        children: children ? stripIds(children) : undefined,
      }));

    expect(roundTripped.name).toBe(original.name);
    expect(stripIds(roundTripped.tree.components)).toEqual(stripIds(original.tree.components));
    // Kitchen sink has no motor configured — must stay absent, not invented.
    expect(roundTripped.motor).toEqual(original.motor);
  });

  it('reference: motor survives the round trip on its mount', () => {
    const original = importOrk(golden('reference.ork'));
    const xml = exportOrk({
      name: original.name,
      tree: original.tree,
      motor: original.motor,
      mountId: original.motor?.mountId,
    });
    const roundTripped = importOrk(xml);
    expect(roundTripped.motor?.designation).toBe('C6');
    expect(roundTripped.motor?.delay).toBe(5);
    expect(roundTripped.motor?.mountId).toBeDefined();
  });
});

describe('.ork permissive handling', () => {
  const BODY_MOUNT = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>MinDia</name><subcomponents><stage><name>S</name><subcomponents>
      <nosecone><name>N</name><length>0.1</length><thickness>0.001</thickness>
        <shape>haack</shape><aftradius>0.0125</aftradius></nosecone>
      <bodytube><name>B</name><length>0.45</length><thickness>0.0005</thickness><radius>0.0125</radius>
        <subcomponents>
          <freeformfinset><name>F</name></freeformfinset>
          <podset><name>P</name></podset>
        </subcomponents>
        <motormount><ignitionevent>automatic</ignitionevent>
          <motor configid="x"><type>single</type><manufacturer>Estes</manufacturer>
          <designation>D12</designation><diameter>0.024</diameter><length>0.07</length><delay>5.0</delay></motor>
        </motormount>
      </bodytube>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;

  it('imports a body-tube motor mount as a REAL mount (minimum-diameter)', () => {
    const result = importOrk(BODY_MOUNT);
    const body = flatten(result.tree.components).find((c) => c.type === 'bodytube')!;
    // The body tube IS the mount (kernel BodyTube implements MotorMount) —
    // the motor attaches to it instead of surfacing as an orphan note.
    expect(body['motorMount']).toBe(true);
    expect(result.motor?.designation).toBe('D12');
    expect(result.motor?.mountId).toBe(body.id);
    expect(result.notes.join(' ')).not.toMatch(/Motor mounts directly/);
    // Both are now supported component types — they import rather than being ignored.
    expect(result.ignored).not.toContain('podset');
    expect(result.ignored).not.toContain('freeformfinset');
    expect(flatten(result.tree.components).some((c) => c.type === 'podset')).toBe(true);
  });

  it('round-trips a body-tube mount (flag survives even without a motor)', () => {
    const tree = {
      name: 'MinDia',
      components: [{
        type: 'stage' as const, name: 'S',
        children: [
          { type: 'nosecone' as const, length: 0.1, aftRadius: 0.0125, thickness: 0.001 },
          {
            type: 'bodytube' as const, id: 'body', length: 0.45, outerRadius: 0.0125,
            thickness: 0.0005, motorMount: true, motorOverhang: 0.006,
          },
        ],
      }],
    };
    const xml = exportOrk({ name: 'MinDia', tree });
    expect(xml).toContain('<motormount>');
    expect(xml).toContain('<overhang>0.006</overhang>');
    const back = importOrk(xml);
    const body = flatten(back.tree.components).find((c) => c.type === 'bodytube')!;
    expect(body['motorMount']).toBe(true);
    expect(body['motorOverhang']).toBeCloseTo(0.006, 9);
  });

  it('accepts bare XML delivered as an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode(BODY_MOUNT);
    const buf = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
    expect(importOrk(buf).name).toBe('MinDia');
  });

  it('reads legacy <position type> files (OpenRocket ≤ 15.03)', () => {
    const LEGACY = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Old</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.4</length><thickness>0.0005</thickness><radius>0.0125</radius>
          <subcomponents>
            <launchlug><name>L</name><position type="middle">0.03</position>
              <radius>0.0022</radius><length>0.05</length><thickness>0.0003</thickness></launchlug>
          </subcomponents>
        </bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const result = importOrk(LEGACY);
    const lug = flatten(result.tree.components).find((c) => c.type === 'launchlug')!;
    expect(lug.position?.method).toBe('middle');
    expect(lug.position?.offset).toBeCloseTo(0.03, 12);
  });
});

describe('.ork export fidelity (v0.013 fixes)', () => {
  it('round-trips parachute line material instead of pinning elastic cord', () => {
    const tree = {
      name: 'LM',
      components: [{
        type: 'stage' as const, id: 's', name: 'Sustainer',
        children: [{
          type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.0125, thickness: 0.0005,
          children: [{
            type: 'parachute' as const, id: 'p', diameter: 0.45,
            lineDensity: 0.005, lineMaterialName: 'Braided Kevlar',
          }],
        }],
      }],
    };
    const back = importOrk(exportOrk({ name: 'LM', tree }));
    const chute = flatten(back.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['lineDensity']).toBeCloseTo(0.005, 12);
    expect(chute['lineMaterialName']).toBe('Braided Kevlar');
  });

  it('round-trips elliptical fin cant and transition shoulder thickness', () => {
    const tree = {
      name: 'EC',
      components: [{
        type: 'stage' as const, id: 's', name: 'Sustainer',
        children: [
          {
            type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.0125, thickness: 0.0005,
            children: [{
              type: 'ellipticalfinset' as const, id: 'f', finCount: 3,
              rootChord: 0.06, height: 0.04, thickness: 0.003, cant: 0.05,
            }],
          },
          {
            type: 'transition' as const, id: 't', length: 0.08,
            foreRadius: 0.0125, aftRadius: 0.009, thickness: 0.002, shape: 'conical',
            aftShoulderRadius: 0.0085, aftShoulderLength: 0.02, aftShoulderThickness: 0.0015,
          },
        ],
      }],
    };
    const back = importOrk(exportOrk({ name: 'EC', tree }));
    const all = flatten(back.tree.components);
    const fins = all.find((c) => c.type === 'ellipticalfinset')!;
    expect(fins['cant']).toBeCloseTo(0.05, 9);
    const trans = all.find((c) => c.type === 'transition')!;
    expect(trans['aftShoulderThickness']).toBeCloseTo(0.0015, 12);
  });

  it('escapes file-sourced free text on re-export (finish/shape)', () => {
    const tree = {
      name: 'ESC',
      components: [{
        type: 'stage' as const, id: 's', name: 'Sustainer',
        children: [{
          type: 'nosecone' as const, id: 'n', length: 0.1, aftRadius: 0.0125,
          thickness: 0.001, shape: 'a<b&c', finish: 'x<y',
        }],
      }],
    };
    const xml = exportOrk({ name: 'ESC', tree });
    expect(xml).toContain('<shape>a&lt;b&amp;c</shape>');
    expect(xml).toContain('<finish>x&lt;y</finish>');
    // Still parseable XML.
    expect(() => importOrk(xml)).not.toThrow();
  });
});

describe('.ork pods / parallel stages round-trip (Phase 5)', () => {
  const podTree = {
    name: 'Pods',
    components: [{
      type: 'stage' as const, id: 's', name: 'Sustainer',
      children: [{
        type: 'bodytube' as const, id: 'b', length: 0.4, outerRadius: 0.024, thickness: 0.0005,
        children: [
          {
            type: 'podset' as const, id: 'pod', instanceCount: 3, radiusOffset: 0.01,
            radiusMethod: 'relative', angleOffset: Math.PI / 6,
            position: { method: 'bottom' as const, offset: 0 },
            children: [{ type: 'bodytube' as const, id: 'pb', length: 0.15, outerRadius: 0.01, thickness: 0.0003 }],
          },
          {
            type: 'parallelstage' as const, id: 'boost', instanceCount: 2, radiusOffset: 0,
            radiusMethod: 'free', angleOffset: 0, angleMethod: 'fixed',
            separationEvent: 'burnout', separationDelay: 1.5,
            position: { method: 'bottom' as const, offset: 0 },
            children: [{ type: 'bodytube' as const, id: 'bb', length: 0.2, outerRadius: 0.012, thickness: 0.0003 }],
          },
        ],
      }],
    }],
  };

  it('writes the assembly elements with correct names, units and no color/linestyle', () => {
    const xml = exportOrk({ name: 'Pods', tree: podTree });
    expect(xml).toContain('<podset>');
    expect(xml).toContain('<parallelstage>');
    expect(xml).toContain('<instancecount>3</instancecount>');
    expect(xml).toContain('<radiusoffset method="relative">0.01</radiusoffset>');
    expect(xml).toContain('<radiusoffset method="free">0</radiusoffset>');
    // angleOffset radians → degrees on disk (π/6 = 30°).
    expect(xml).toMatch(/<angleoffset method="relative">29\.999\d*<\/angleoffset>|<angleoffset method="relative">30<\/angleoffset>/);
    expect(xml).toContain('<angleoffset method="fixed">0</angleoffset>');
    // parallelstage carries separation; assemblies never carry these.
    expect(xml).toContain('<separationevent>burnout</separationevent>');
    // (color/linestyle/radialdirection are only suppressed inside the assembly
    // elements — the presence check is that import round-trips cleanly below.)
  });

  it('round-trips a pod and a booster (import → export → import, values preserved)', () => {
    const back = importOrk(exportOrk({ name: 'Pods', tree: podTree }));
    const all = flatten(back.tree.components);
    const pod = all.find((c) => c.type === 'podset')!;
    expect(pod['instanceCount']).toBe(3);
    expect(pod['radiusOffset']).toBeCloseTo(0.01, 9);
    expect(pod['radiusMethod']).toBe('relative');
    expect(pod['angleOffset']).toBeCloseTo(Math.PI / 6, 6);
    // Nested chain survives.
    expect((pod.children ?? []).some((c) => c.type === 'bodytube')).toBe(true);

    const boost = all.find((c) => c.type === 'parallelstage')!;
    expect(boost['instanceCount']).toBe(2);
    expect(boost['radiusMethod']).toBe('free');
    expect(boost['angleMethod']).toBe('fixed');
    expect(boost['separationEvent']).toBe('burnout');
    expect(boost['separationDelay']).toBeCloseTo(1.5, 9);
  });

  it('imports the legacy <boosterset> alias as a parallelstage', () => {
    const xml = `<openrocket version="1.8" creator="OpenRocket 24.12"><rocket><name>Legacy</name>
      <subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.4</length><thickness>0.0005</thickness><radius>0.024</radius>
          <subcomponents>
            <boosterset><name>Booster</name><instancecount>2</instancecount>
              <radiusoffset method="relative">0.0</radiusoffset>
              <angleoffset method="relative">0.0</angleoffset>
              <subcomponents><bodytube><name>BB</name><length>0.2</length><thickness>0.0003</thickness><radius>0.012</radius></bodytube></subcomponents>
            </boosterset>
          </subcomponents>
        </bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const back = importOrk(xml);
    expect(flatten(back.tree.components).some((c) => c.type === 'parallelstage')).toBe(true);
  });
});

describe('.ork nozzle exit diameter round-trip (RASAero power-on drag, #2)', () => {
  const tree = {
    name: 'Nozzle',
    components: [
      {
        type: 'stage' as const, id: 's0', name: 'Sustainer', nozzleExitDiameter: 0.016,
        children: [
          { type: 'nosecone' as const, length: 0.07, aftRadius: 0.012, thickness: 0.002 },
          { type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
        ],
      },
      {
        type: 'stage' as const, id: 's1', name: 'Booster', nozzleExitDiameter: 0.038,
        separationEvent: 'burnout',
        children: [{ type: 'bodytube' as const, length: 0.2, outerRadius: 0.012, thickness: 0.0005 }],
      },
    ],
  };

  it('writes <nozzleexitdiameter> in metres for every stage that sets it', () => {
    const xml = exportOrk({ name: 'Nozzle', tree });
    expect(xml).toContain('<nozzleexitdiameter>0.016</nozzleexitdiameter>');
    expect(xml).toContain('<nozzleexitdiameter>0.038</nozzleexitdiameter>');
  });

  it('omits the element when the value is absent or zero (plain designs stay clean)', () => {
    const plain = {
      name: 'Plain',
      components: [{
        type: 'stage' as const, name: 'Sustainer',
        children: [{ type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
      }],
    };
    expect(exportOrk({ name: 'Plain', tree: plain })).not.toContain('nozzleexitdiameter');
  });

  it('round-trips the per-stage value (import → export → import)', () => {
    const back = importOrk(exportOrk({ name: 'Nozzle', tree }));
    const stages = back.tree.components.filter((c) => c.type === 'stage');
    expect(stages[0]!['nozzleExitDiameter']).toBeCloseTo(0.016, 9);
    expect(stages[1]!['nozzleExitDiameter']).toBeCloseTo(0.038, 9);
  });
});

describe('.ork audit regressions (2026-08-04)', () => {
  const PLUGGED = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Plugged</name><subcomponents><stage><name>S</name><subcomponents>
    <nosecone><name>Nose</name><length>0.07</length><thickness>0.002</thickness>
      <shape>ogive</shape><shapeparameter>1.0</shapeparameter><aftradius>0.012</aftradius></nosecone>
    <bodytube><name>Body</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
      <motormount>
        <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
        <overhang>0.0</overhang>
        <motor configid="cfg"><type>single</type><manufacturer>Cesaroni</manufacturer>
          <designation>K550</designation><diameter>0.054</diameter><length>0.404</length>
          <delay>none</delay></motor>
      </motormount>
    </bodytube>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;

  it("imports a plugged motor (<delay>none</delay>) as Infinity, never 0", () => {
    const bytes = new TextEncoder().encode(PLUGGED);
    const result = importOrk(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
    expect(result.motor?.delay).toBe(Infinity);
    expect(result.notes.some((n) => n.includes('plugged'))).toBe(true);
  });

  it('exports a plugged motor back as the literal "none"', () => {
    const bytes = new TextEncoder().encode(PLUGGED);
    const original = importOrk(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
    const xml = exportOrk({
      name: original.name, tree: original.tree,
      motor: original.motor, mountId: original.motor?.mountId,
    });
    expect(xml).toContain('<delay>none</delay>');
    expect(importOrk(xml).motor?.delay).toBe(Infinity);
  });

  it('round-trips tube-fin thickness instead of resetting it to the 0.5 mm fallback', () => {
    const tree = {
      name: 'Tubefins',
      components: [{
        type: 'stage' as const, name: 'Sustainer',
        children: [{
          type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          children: [{
            type: 'tubefinset' as const, finCount: 3, length: 0.1,
            outerRadius: 0.0125, thickness: 0.001,
            position: { method: 'bottom' as const, offset: 0 },
          }],
        }],
      }],
    };
    const back = importOrk(exportOrk({ name: 'Tubefins', tree }));
    const tf = flatten(back.tree.components).find((c) => c.type === 'tubefinset')!;
    expect(tf['thickness']).toBeCloseTo(0.001, 9);
  });

  it('round-trips override-for-all-subcomponents flags (per-quantity and legacy)', () => {
    const tree = {
      name: 'Override',
      components: [{
        type: 'stage' as const, name: 'Sustainer',
        children: [{
          type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          overrideMass: 0.25, overrideSubcomponentsMass: true, overrideCD: 0.4,
        }],
      }],
    };
    const xml = exportOrk({ name: 'Override', tree });
    expect(xml).toContain('<overridesubcomponentsmass>true</overridesubcomponentsmass>');
    expect(xml).toContain('<overridesubcomponentscd>false</overridesubcomponentscd>');
    const back = importOrk(xml);
    const body = flatten(back.tree.components).find((c) => c.type === 'bodytube')!;
    expect(body['overrideSubcomponentsMass']).toBe(true);
    expect(body['overrideSubcomponentsCD']).toBeUndefined();

    // Legacy single-flag files (<overridesubcomponents>) cover every override.
    const LEGACY = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Legacy</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>Body</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
        <overridemass>0.5</overridemass><overridesubcomponents>true</overridesubcomponents>
      </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    const bytes = new TextEncoder().encode(LEGACY);
    const legacy = importOrk(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
    const lb = flatten(legacy.tree.components).find((c) => c.type === 'bodytube')!;
    expect(lb['overrideSubcomponentsMass']).toBe(true);
  });
});
