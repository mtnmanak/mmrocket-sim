// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, PANEL_TIME_STEP_FLOOR_S } from '../components/LaunchPanel.js';
import { exportOrk, flightDataAttrs, importOrk, MIN_IMPORTED_TIME_STEP_S, ORK_CREATOR, type OrkExportConfig, type OrkMotorRef } from './orkFile.js';

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
    // The exported root element must stamp OUR product name as creator, not
    // OpenRocket's own or a stale/renamed product — this is the one line a
    // future rename could silently drop.
    expect(xml).toContain('<openrocket version="1.10" creator="MMRocket Sim">');
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

describe('.ork launch conditions (simulations block)', () => {
  const SIMPLE_TREE = {
    name: 'Cond',
    components: [{
      type: 'stage' as const, name: 'Sustainer',
      children: [
        { type: 'nosecone' as const, length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        { type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
      ],
    }],
  };

  it('writes an empty <simulations> and imports no launch when none given', () => {
    const xml = exportOrk({ name: 'Cond', tree: SIMPLE_TREE });
    expect(xml).not.toContain('<simulation ');
    expect(importOrk(xml).launch).toBeUndefined();
  });

  it('round-trips custom launch conditions through one <simulation>', () => {
    const xml = exportOrk({
      name: 'Cond', tree: SIMPLE_TREE,
      launch: {
        launchRodLengthM: 1.8288, launchRodAngleDeg: 5, windAverage: 4,
        windStdDev: 0.8, launchAltitudeM: 1350, temperatureC: 25,
        pressureHPa: 1015, latitudeDeg: 39.1,
      },
    });
    // Desktop-required attributes (its loader warns on anything else).
    expect(xml).toContain('<simulation status="notsimulated">');
    expect(xml).toContain('<simulator>RK4Simulator</simulator>');
    expect(xml).toContain('<calculator>BarrowmanCalculator</calculator>');
    const back = importOrk(xml).launch!;
    expect(back.launchRodLengthM).toBeCloseTo(1.8288, 12);
    expect(back.launchRodAngleDeg).toBeCloseTo(5, 12); // degrees on disk, degrees in the type
    expect(back.windAverage).toBeCloseTo(4, 12);
    expect(back.windStdDev).toBeCloseTo(0.8, 12);
    expect(back.launchAltitudeM).toBeCloseTo(1350, 12);
    expect(back.temperatureC).toBeCloseTo(25, 9);  // Kelvin on disk
    expect(back.pressureHPa).toBeCloseTo(1015, 9); // Pascal on disk
    expect(back.latitudeDeg).toBeCloseTo(39.1, 12);
  });

  it('round-trips the ISA standard atmosphere as null temperature/pressure', () => {
    const xml = exportOrk({
      name: 'Cond', tree: SIMPLE_TREE,
      launch: {
        launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 2, windStdDev: 0.2,
        launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 28.61,
      },
    });
    expect(xml).toContain('<atmosphere model="isa"/>');
    const back = importOrk(xml).launch!;
    expect(back.temperatureC).toBeNull();
    expect(back.pressureHPa).toBeNull();
  });

  it('round-trips zero wind without inventing turbulence (0/0 intensity)', () => {
    const xml = exportOrk({
      name: 'Cond', tree: SIMPLE_TREE,
      launch: {
        launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 0, windStdDev: 0,
        launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 28.61,
      },
    });
    expect(xml).toContain('<windturbulence>0</windturbulence>');
    const back = importOrk(xml).launch!;
    expect(back.windAverage).toBe(0);
    expect(back.windStdDev).toBe(0);
  });

  // Shape copied from the desktop 24.12 OpenRocketSaver.saveSimulation():
  // legacy trio + modern <wind model="average"> block, Kelvin/Pascal
  // atmosphere, degrees rod angle. Second simulation must be ignored.
  const DESKTOP_SIM = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>CondTest</name>
    <motorconfiguration configid="a1" default="true"><stage number="0" active="true"/></motorconfiguration>
    <subcomponents><stage><name>S</name><subcomponents>
      <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
    </subcomponents></stage></subcomponents>
  </rocket>
  <simulations>
    <simulation status="uptodate">
      <name>Simulation 1</name>
      <simulator>RK4Simulator</simulator>
      <calculator>BarrowmanCalculator</calculator>
      <conditions>
        <configid>a1</configid>
        <launchrodlength>1.8288</launchrodlength>
        <launchintowind>true</launchintowind>
        <launchrodangle>5.0</launchrodangle>
        <launchroddirection>90.0</launchroddirection>
        <windaverage>4.0</windaverage>
        <windturbulence>0.1</windturbulence>
        <winddirection>1.5707963267948966</winddirection>
        <wind model="average">
          <speed>4.0</speed>
          <direction>1.5707963267948966</direction>
          <standarddeviation>0.5</standarddeviation>
        </wind>
        <windmodeltype>Average</windmodeltype>
        <launchaltitude>1350.0</launchaltitude>
        <launchlatitude>39.1</launchlatitude>
        <launchlongitude>-108.55</launchlongitude>
        <geodeticmethod>wgs84</geodeticmethod>
        <atmosphere model="extendedisa">
          <basetemperature>298.15</basetemperature>
          <basepressure>101500.0</basepressure>
        </atmosphere>
        <timestep>0.05</timestep>
        <maxtime>1200.0</maxtime>
      </conditions>
    </simulation>
    <simulation status="uptodate"><name>Other</name>
      <conditions><launchrodlength>9.9</launchrodlength></conditions>
    </simulation>
  </simulations></openrocket>`;

  it('imports a desktop-written conditions block (first simulation only)', () => {
    const result = importOrk(DESKTOP_SIM);
    const launch = result.launch!;
    expect(launch.launchRodLengthM).toBeCloseTo(1.8288, 12); // not 9.9 — first sim wins
    expect(launch.launchRodAngleDeg).toBeCloseTo(5, 12);
    expect(launch.windAverage).toBeCloseTo(4, 12);
    // Modern <wind> stddev wins over the legacy intensity pair (0.1 x 4 = 0.4).
    expect(launch.windStdDev).toBeCloseTo(0.5, 12);
    expect(launch.launchAltitudeM).toBeCloseTo(1350, 12);
    expect(launch.latitudeDeg).toBeCloseTo(39.1, 12);
    expect(launch.temperatureC).toBeCloseTo(25, 9);
    expect(launch.pressureHPa).toBeCloseTo(1015, 9);
    // Non-spherical geodetic model: the app simulates a spherical Earth.
    expect(result.notes.filter((n) => n.includes('geodetic'))).toHaveLength(1);
  });

  it('falls back to the legacy windturbulence intensity ratio (pre-24.x files)', () => {
    const LEGACY = DESKTOP_SIM
      .replace(/<wind model="average">[\s\S]*?<\/wind>/, '')
      .replace(/<windmodeltype>Average<\/windmodeltype>/, '')
      .replace(/<geodeticmethod>wgs84<\/geodeticmethod>/, '<geodeticmethod>spherical</geodeticmethod>');
    const result = importOrk(LEGACY);
    // stddev = intensity x average = 0.1 x 4.
    expect(result.launch!.windStdDev).toBeCloseTo(0.4, 12);
    expect(result.notes.filter((n) => n.includes('geodetic'))).toHaveLength(0);
  });

  it('notes that a MultiLevel wind profile was replaced by the average-wind settings', () => {
    const ml = DESKTOP_SIM
      .replace('<windmodeltype>Average</windmodeltype>', '<windmodeltype>MultiLevel</windmodeltype>');
    const result = importOrk(ml);
    const notes = result.notes.filter((n) => n.includes('multilevel wind'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('average-wind settings were imported instead');
    // The average settings still import — the note explains them, not a failure.
    expect(result.launch!.windAverage).toBeCloseTo(4, 12);
  });

  it('notes a multilevel <wind> element even without a windmodeltype tag', () => {
    const ml = DESKTOP_SIM
      .replace('<windmodeltype>Average</windmodeltype>', '')
      .replace('<wind model="average">', '<wind model="multilevel">');
    const notes = importOrk(ml).notes.filter((n) => n.includes('multilevel wind'));
    expect(notes).toHaveLength(1);
  });

  it('stays silent on plain average-wind files', () => {
    expect(importOrk(DESKTOP_SIM).notes.some((n) => n.includes('multilevel'))).toBe(false);
  });
});

describe('.ork launch conditions come from the CHOSEN configuration', () => {
  // Two flight configurations, two simulations, deliberately out of order: the
  // FIRST <simulation> belongs to cfg-b, the second to the default cfg-a. A file
  // whose configurations fly different sites (a summer launch and a winter one)
  // must not have the wrong site's air applied to it.
  const TWO_SIMS = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>TwoSims</name>
    <motorconfiguration configid="cfg-a" default="true"><stage number="0" active="true"/></motorconfiguration>
    <motorconfiguration configid="cfg-b"><stage number="0" active="true"/></motorconfiguration>
    <subcomponents><stage><name>S</name><subcomponents>
      <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
    </subcomponents></stage></subcomponents>
  </rocket>
  <simulations>
    <simulation status="uptodate"><name>The other one</name>
      <conditions>
        <configid>cfg-b</configid>
        <launchrodlength>3.0</launchrodlength>
        <launchaltitude>2000.0</launchaltitude>
        <atmosphere model="extendedisa"><basetemperature>310.15</basetemperature><basepressure>90000.0</basepressure></atmosphere>
      </conditions>
    </simulation>
    <simulation status="uptodate"><name>The default one</name>
      <conditions>
        <configid>cfg-a</configid>
        <launchrodlength>1.0</launchrodlength>
        <launchaltitude>100.0</launchaltitude>
        <atmosphere model="isa"/>
      </conditions>
    </simulation>
  </simulations></openrocket>`;

  it('takes the simulation matching the default configuration, not the first one', () => {
    const launch = importOrk(TWO_SIMS).launch!;
    expect(launch.launchRodLengthM).toBeCloseTo(1.0, 12);
    expect(launch.launchAltitudeM).toBeCloseTo(100, 12);
    // <atmosphere model="isa"> means "blank = standard", not cfg-b's 37 C day.
    expect(launch.temperatureC).toBeNull();
  });

  it('follows an explicitly chosen configuration', () => {
    const launch = importOrk(TWO_SIMS, { configId: 'cfg-b' }).launch!;
    expect(launch.launchRodLengthM).toBeCloseTo(3.0, 12);
    expect(launch.launchAltitudeM).toBeCloseTo(2000, 12);
    expect(launch.temperatureC).toBeCloseTo(310.15 - 273.15, 9);
  });

  it('falls back to the first simulation when none names the chosen config', () => {
    const orphaned = TWO_SIMS.replace('<configid>cfg-a</configid>', '<configid>cfg-zz</configid>')
      .replace('<configid>cfg-b</configid>', '<configid>cfg-yy</configid>');
    expect(importOrk(orphaned).launch!.launchRodLengthM).toBeCloseTo(3.0, 12);
  });
});


// Desktop file shape (24.12 savers): rocket-level declarations with
// optional <name>/default="true" and <stage number active> children;
// per mount, bare ignition defaults + one <motor configid> per non-empty
// config + <ignitionconfiguration> only for overriding configs; recovery
// devices bare deploy tags + <deploymentconfiguration> overrides; stages
// bare separation tags + a <separationconfiguration> for EVERY config.
// cfg-b is a "sustainer only" flight: booster stage inactive, no booster
// motor. Shared by the Stage A import and Stage B export describes.
const MULTI = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>MultiCfg</name>
    <motorconfiguration configid="cfg-a" default="true">
      <name>Club field C6</name>
      <stage number="0" active="true"/>
      <stage number="1" active="true"/>
    </motorconfiguration>
    <motorconfiguration configid="cfg-b">
      <name>Demo day D12</name>
      <stage number="0" active="true"/>
      <stage number="1" active="false"/>
    </motorconfiguration>
    <subcomponents>
      <stage><name>Sustainer</name><subcomponents>
        <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
          <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
        <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
          <motormount>
            <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
            <overhang>0.0</overhang>
            <motor configid="cfg-a"><type>single</type><manufacturer>Estes</manufacturer>
              <designation>C6</designation><diameter>0.018</diameter><length>0.07</length>
              <delay>5.0</delay></motor>
            <motor configid="cfg-b"><type>single</type><manufacturer>Estes</manufacturer>
              <designation>D12</designation><diameter>0.024</diameter><length>0.07</length>
              <delay>7.0</delay></motor>
            <ignitionconfiguration configid="cfg-b">
              <ignitionevent>launch</ignitionevent><ignitiondelay>1.5</ignitiondelay>
            </ignitionconfiguration>
          </motormount>
          <subcomponents>
            <parachute><name>Chute</name><diameter>0.3</diameter><cd>auto</cd>
              <deployevent>ejection</deployevent><deployaltitude>200.0</deployaltitude><deploydelay>0.0</deploydelay>
              <deploymentconfiguration configid="cfg-b">
                <deployevent>altitude</deployevent><deployaltitude>150.0</deployaltitude><deploydelay>1.0</deploydelay>
              </deploymentconfiguration>
            </parachute>
          </subcomponents>
        </bodytube>
      </subcomponents></stage>
      <stage><name>Booster</name>
        <separationevent>ejection</separationevent><separationaltitude>200.0</separationaltitude><separationdelay>0.0</separationdelay>
        <separationconfiguration configid="cfg-a">
          <separationevent>ejection</separationevent><separationaltitude>200.0</separationaltitude><separationdelay>0.0</separationdelay>
        </separationconfiguration>
        <separationconfiguration configid="cfg-b">
          <separationevent>burnout</separationevent><separationaltitude>200.0</separationaltitude><separationdelay>2.0</separationdelay>
        </separationconfiguration>
        <subcomponents>
          <bodytube><name>BB</name><length>0.2</length><thickness>0.0005</thickness><radius>0.012</radius>
            <motormount>
              <ignitionevent>automatic</ignitionevent><ignitiondelay>0.0</ignitiondelay>
              <overhang>0.0</overhang>
              <motor configid="cfg-a"><type>single</type><manufacturer>Estes</manufacturer>
                <designation>D12</designation><diameter>0.024</diameter><length>0.07</length>
                <delay>0.0</delay></motor>
            </motormount>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents></rocket></openrocket>`;

describe('.ork round-trip preservation of data the app does not model yet', () => {
  const withExtras = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Extras</name>
    <subcomponents><stage><name>Sustainer</name><subcomponents>
      <nosecone><name>N</name><length>0.1</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.05</aftradius></nosecone>
      <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness><radius>0.05</radius>
        <subcomponents>
          <trapezoidfinset><name>Fins</name><fincount>4</fincount><thickness>0.004</thickness>
            <rootchord>0.2</rootchord><tipchord>0.1</tipchord><sweeplength>0.05</sweeplength>
            <height>0.1</height>
            <filletradius>0.006</filletradius>
            <filletmaterial type="bulk" density="1250.0" group="Plastics">Epoxy</filletmaterial>
          </trapezoidfinset>
          <centeringring><name>CRs</name><length>0.003</length>
            <instancecount>3</instancecount><instanceseparation>0.05</instanceseparation>
          </centeringring>
          <railbutton><name>Buttons</name><outerdiameter>0.0097</outerdiameter>
            <instancecount>2</instancecount><instanceseparation>0.4</instanceseparation>
          </railbutton>
        </subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents>
  </rocket></openrocket>`;

  it('keeps fin fillets instead of zeroing them on save', () => {
    // The exporter used to hard-write <filletradius>0.0</filletradius> and a
    // Cardboard material, so opening a desktop design with epoxy fillets and
    // saving DELETED them from the user's own file — tens of grams on an HPR
    // fin can, with the stability margin moving to match.
    const r = importOrk(withExtras);
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['filletRadius']).toBeCloseTo(0.006, 9);
    expect(fins['filletMaterialName']).toBe('Epoxy');

    const xml = exportOrk({ name: 'Extras', tree: r.tree });
    expect(xml).toContain('<filletradius>0.006</filletradius>');
    expect(xml).toContain('Epoxy</filletmaterial>');
    expect(xml).not.toContain('<filletradius>0.0</filletradius>');

    const back = importOrk(xml);
    expect(flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!['filletRadius'])
      .toBeCloseTo(0.006, 9);
  });

  it('keeps instanced rings and rail buttons instead of collapsing them to one', () => {
    const r = importOrk(withExtras);
    const ring = flatten(r.tree.components).find((c) => c.type === 'centeringring')!;
    expect(ring['instanceCount']).toBe(3);
    expect(ring['instanceSeparation']).toBeCloseTo(0.05, 9);

    const xml = exportOrk({ name: 'Extras', tree: r.tree });
    const back = importOrk(xml);
    const ringBack = flatten(back.tree.components).find((c) => c.type === 'centeringring')!;
    expect(ringBack['instanceCount']).toBe(3);
    expect(ringBack['instanceSeparation']).toBeCloseTo(0.05, 9);
    const buttons = flatten(back.tree.components).find((c) => c.type === 'railbutton')!;
    expect(buttons['instanceCount']).toBe(2);
  });

  it('tells the user what is preserved-but-not-simulated rather than staying silent', () => {
    const r = importOrk(withExtras);
    expect(r.notes.join(' ')).toMatch(/multiple instances/i);
    // Fillets USED to be on this list. The kernel counts fillet epoxy in mass
    // and CG now, so claiming otherwise would be the error.
    expect(r.notes.join(' ')).not.toMatch(/fillet/i);
  });
});

describe('.ork multi-configuration import (Stage A)', () => {
  it('applies the default configuration when no pick is given', () => {
    const result = importOrk(MULTI);
    expect(result.configs.map(({ motors: _m, deployments: _d, separations: _s, ...rest }) => rest)).toEqual([
      { id: 'cfg-a', name: 'Club field C6', isDefault: true },
      { id: 'cfg-b', name: 'Demo day D12', isDefault: false },
    ]);
    // Each config carries its own resolved chute deployment, so a save made
    // under one cannot rewrite the other's (see the Stage B export describe).
    const [cfgA, cfgB] = result.configs;
    expect(Object.values(cfgA!.deployments)[0]).toMatchObject({ deployEvent: 'ejection', deployAltitude: 200 });
    expect(Object.values(cfgB!.deployments)[0]).toMatchObject({ deployEvent: 'altitude', deployAltitude: 150 });
    expect(result.chosenConfigId).toBe('cfg-a');
    // Both mounts carry a cfg-a motor.
    expect(result.motor?.designation).toBe('C6');
    expect(result.motor?.delay).toBe(5);
    expect(Object.values(result.motors).map((m) => m.designation).sort()).toEqual(['C6', 'D12']);
    // Ignition: cfg-b's override block must NOT leak — bare defaults apply.
    expect(result.motor?.ignitionEvent).toBe('automatic');
    expect(result.motor?.ignitionDelay).toBe(0);
    // Deployment: bare tags, not cfg-b's override block.
    const chute = flatten(result.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('ejection');
    expect(chute['deployAltitude']).toBeCloseTo(200, 12);
    expect(chute['deployDelay']).toBeCloseTo(0, 12);
    // Separation: cfg-a's block carries the sparse defaults — nothing stored.
    const booster = result.tree.components[1]!;
    expect(booster['separationEvent']).toBeUndefined();
    expect(booster['separationDelay']).toBeUndefined();
    const notes = result.notes.filter((n) => n.includes('flight configuration'));
    expect(notes).toHaveLength(1);
    // The note replaced the open-time picker modal (2026-08-22b): it must name
    // the configuration that loaded, say it is the file's default, and point at
    // where to change it.
    expect(notes[0]).toBe(
      'Opened “Club field C6”, the file’s default flight configuration (2 in the file). '
      + 'Switch between them under Motors & Launch → Flight configurations.');
    // cfg-a flies every stage — no activeness caveat.
    expect(result.notes.some((n) => n.includes('deactivates'))).toBe(false);
  });

  it('opts.configId picks the other configuration, overrides included', () => {
    const result = importOrk(MULTI, { configId: 'cfg-b' });
    expect(result.chosenConfigId).toBe('cfg-b');
    expect(result.motor?.designation).toBe('D12');
    expect(result.motor?.delay).toBe(7);
    // The booster mount has no cfg-b motor — it imports empty.
    expect(Object.values(result.motors).map((m) => m.designation)).toEqual(['D12']);
    // Ignition/deployment/separation: cfg-b's override blocks apply.
    expect(result.motor?.ignitionEvent).toBe('launch');
    expect(result.motor?.ignitionDelay).toBeCloseTo(1.5, 12);
    const chute = flatten(result.tree.components).find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('altitude');
    expect(chute['deployAltitude']).toBeCloseTo(150, 12);
    expect(chute['deployDelay']).toBeCloseTo(1, 12);
    const booster = result.tree.components[1]!;
    expect(booster['separationEvent']).toBe('burnout');
    expect(booster['separationDelay']).toBeCloseTo(2, 12);
    const notes = result.notes.filter((n) => n.includes('flight configuration'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Opened “Demo day D12”');
    // Picking a NON-default configuration must not claim it is the default.
    expect(notes[0]).not.toContain('the file’s default');
    // cfg-b grounds the booster stage — activeness isn't applied yet, say so.
    expect(result.notes.filter((n) => n.includes('deactivates'))).toHaveLength(1);
    expect(result.notes.find((n) => n.includes('deactivates'))).toContain('all stages fly');
  });

  it('every config rides along with its own resolved motors (Stage B presets)', () => {
    const result = importOrk(MULTI);
    const [cfgA, cfgB] = result.configs;
    // cfg-a (the chosen default): its preset IS the applied motor set.
    expect(cfgA!.motors).toEqual(result.motors);
    expect(Object.values(cfgA!.motors).map((m) => m.designation).sort()).toEqual(['C6', 'D12']);
    // Bare ignition defaults for cfg-a — cfg-b's override block stays out.
    expect(Object.values(cfgA!.motors).every(
      (m) => m.ignitionEvent === 'automatic' && m.ignitionDelay === 0)).toBe(true);
    // cfg-b: sustainer only, with ITS ignition override applied.
    const bRefs = Object.values(cfgB!.motors);
    expect(bRefs).toHaveLength(1);
    expect(bRefs[0]!.designation).toBe('D12');
    expect(bRefs[0]!.delay).toBe(7);
    expect(bRefs[0]!.ignitionEvent).toBe('launch');
    expect(bRefs[0]!.ignitionDelay).toBeCloseTo(1.5, 12);
    // Keyed by THIS parse's node ids: cfg-b's one mount is the same
    // sustainer mount the chosen config's C6 sits on.
    expect(cfgB!.motors[result.motor!.mountId!]).toBeDefined();
  });

  it('presets are pick-independent: choosing cfg-b leaves cfg-a complete', () => {
    const result = importOrk(MULTI, { configId: 'cfg-b' });
    expect(result.configs[1]!.motors).toEqual(result.motors);
    expect(Object.values(result.configs[0]!.motors).map((m) => m.designation).sort())
      .toEqual(['C6', 'D12']);
  });

  it('falls back to the default when opts.configId names no declared config', () => {
    const result = importOrk(MULTI, { configId: 'cfg-nope' });
    expect(result.chosenConfigId).toBe('cfg-a');
    expect(result.motor?.designation).toBe('C6');
  });

  it('separation falls back to the bare tags when the chosen config has no block', () => {
    const stripped = MULTI
      .replace(/<separationconfiguration configid="cfg-a">[\s\S]*?<\/separationconfiguration>/, '')
      .replace('<separationdelay>0.0</separationdelay>', '<separationdelay>3.0</separationdelay>');
    const booster = importOrk(stripped).tree.components[1]!;
    expect(booster['separationDelay']).toBeCloseTo(3, 12);
  });

  it('single-config files behave exactly as before, config-note free', () => {
    const result = importOrk(golden('reference.ork'));
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.isDefault).toBe(true);
    expect(result.chosenConfigId).toBe(result.configs[0]!.id);
    expect(result.motor?.designation).toBe('C6');
    expect(result.notes.some((n) => n.includes('flight configuration'))).toBe(false);
  });

  it('says nothing was kept when the declared configs carry no motors at all', () => {
    // Both mounts' <motor> blocks removed: two rocket-level declarations
    // remain but every mount is empty — the note must not claim a
    // configuration was opened.
    const noMotors = MULTI.replace(/<motor configid[\s\S]*?<\/motor>/g, '');
    const result = importOrk(noMotors);
    expect(Object.keys(result.motors)).toHaveLength(0);
    const notes = result.notes.filter((n) => n.includes('flight configurations'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('carried no motors to import');
    expect(notes[0]).not.toContain('Opened');
  });

  it('keeps the legacy first-motor read and note for undeclared configids', () => {
    // Hand-rolled shape: no rocket-level declarations, several stray
    // <motor configid>s — the old behavior, preserved.
    const undeclared = MULTI.replace(/<motorconfiguration[\s\S]*?<\/motorconfiguration>/g, '');
    const result = importOrk(undeclared);
    expect(result.configs).toEqual([]);
    expect(result.chosenConfigId).toBeNull();
    expect(result.motor?.designation).toBe('C6'); // first in document order
    const note = result.notes.find((n) => n.includes('flight configurations'))!;
    expect(note).toContain('kept “cfg-a”');
    expect(note).toContain('1 was not imported');
  });
});

describe('.ork multi-configuration export (Stage B)', () => {
  const TREE = {
    name: 'MC',
    components: [{
      type: 'stage' as const, id: 's', name: 'Sustainer',
      children: [{
        type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012,
        thickness: 0.0005, motorMount: true,
      }],
    }],
  };
  const C6 = {
    designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07,
    delay: 5, ignitionEvent: 'automatic', ignitionDelay: 0,
  };
  const D12 = {
    designation: 'D12', manufacturer: 'Estes', diameter: 0.024, length: 0.07,
    delay: 7, ignitionEvent: 'launch', ignitionDelay: 1.5,
  };
  const CONFIGS: OrkExportConfig[] = [
    { id: 'cfg-a', name: 'Club field C6', isDefault: true, motors: { b: C6 } },
    { id: 'cfg-b', name: null, isDefault: false, motors: { b: D12 } },
  ];
  const LAUNCH = {
    launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 2, windStdDev: 0.2,
    launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 28.61,
  };

  it("saving under one config does not rewrite another config's recovery deployment", () => {
    // The bug this pins was a real recovery hazard: <deploymentconfiguration>
    // was READ (folded onto the node) but never WRITTEN, so opening cfg-b —
    // whose chute deploys at 150 m — and saving made altitude/150 the file's
    // bare default. cfg-a, which deploys at ejection, silently inherited it.
    const openedB = importOrk(MULTI, { configId: 'cfg-b' });
    const chuteB = flatten(openedB.tree.components).find((c) => c.type === 'parachute')!;
    expect(chuteB['deployEvent']).toBe('altitude');
    expect(chuteB['deployAltitude']).toBeCloseTo(150, 9);

    const xml = exportOrk({
      name: 'MC',
      tree: openedB.tree,
      motors: {},
      configs: openedB.configs.map((c) => ({
        id: c.id, name: c.name, isDefault: c.isDefault, motors: {}, deployments: c.deployments,
      })),
      activeConfigId: 'cfg-b',
    });

    // Reopening cfg-a must still give the ejection-at-apogee chute.
    const backA = importOrk(xml, { configId: 'cfg-a' });
    const chuteA = flatten(backA.tree.components).find((c) => c.type === 'parachute')!;
    expect(chuteA['deployEvent']).toBe('ejection');
    expect(chuteA['deployAltitude']).toBeCloseTo(200, 9);

    // ...and cfg-b still deploys at 150 m.
    const backB = importOrk(xml, { configId: 'cfg-b' });
    const chuteB2 = flatten(backB.tree.components).find((c) => c.type === 'parachute')!;
    expect(chuteB2['deployEvent']).toBe('altitude');
    expect(chuteB2['deployAltitude']).toBeCloseTo(150, 9);
  });

  it('writes every config with stable ids/names, default and LIVE motors on the active one', () => {
    const xml = exportOrk({
      name: 'MC', tree: TREE,
      motors: { b: { ...D12, delay: 9 } }, // live working set: edited delay
      configs: CONFIGS, activeConfigId: 'cfg-b', launch: LAUNCH,
    });
    // Stable ids; default="true" rides the ACTIVE config, not the file default.
    expect(xml).toContain('<motorconfiguration configid="cfg-a">');
    expect(xml).toContain('<motorconfiguration configid="cfg-b" default="true">');
    expect(xml).toContain('<name>Club field C6</name>');
    // cfg-b is unnamed — no invented <name> in its block (desktop renders
    // an unnamed config as its motor list).
    const cfgBBlock = xml.match(
      /<motorconfiguration configid="cfg-b"[^>]*>([\s\S]*?)<\/motorconfiguration>/)![1]!;
    expect(cfgBBlock).not.toContain('<name>');
    // The simulation references the default-marked config.
    expect(xml).toContain('<configid>cfg-b</configid>');
    const back = importOrk(xml);
    expect(back.configs.map((c) => ({ id: c.id, name: c.name, isDefault: c.isDefault }))).toEqual([
      { id: 'cfg-a', name: 'Club field C6', isDefault: false },
      { id: 'cfg-b', name: null, isDefault: true },
    ]);
    // Active config carries the LIVE set (delay 9, edits persisted); the
    // inactive preset keeps its own stored motor.
    expect(back.chosenConfigId).toBe('cfg-b');
    expect(back.motor).toMatchObject({ designation: 'D12', delay: 9, ignitionEvent: 'launch' });
    expect(Object.values(back.configs[0]!.motors)[0]).toMatchObject({ designation: 'C6', delay: 5 });
  });

  it('active none with no live motors: the original default keeps default="true", nothing minted', () => {
    const xml = exportOrk({ name: 'MC', tree: TREE, motors: {}, configs: CONFIGS, activeConfigId: null });
    expect((xml.match(/<motorconfiguration /g) ?? []).length).toBe(2);
    expect(xml).toContain('<motorconfiguration configid="cfg-a" default="true">');
    const back = importOrk(xml);
    expect(back.chosenConfigId).toBe('cfg-a');
    expect(back.motor).toMatchObject({ designation: 'C6', delay: 5 }); // the preset survived
  });

  it('active none WITH live motors mints an unnamed default config carrying them', () => {
    const xml = exportOrk({
      name: 'MC', tree: TREE, motors: { b: { ...C6, delay: 3 } },
      configs: CONFIGS, activeConfigId: null,
    });
    const decls = [...xml.matchAll(/<motorconfiguration configid="([^"]+)"( default="true")?>/g)];
    expect(decls).toHaveLength(3);
    // The minted one comes last, freshly-idd, and takes default="true".
    expect(['cfg-a', 'cfg-b']).not.toContain(decls[2]![1]);
    expect(decls[2]![2]).toBe(' default="true"');
    expect(decls[0]![2]).toBeUndefined();
    const back = importOrk(xml);
    expect(back.configs).toHaveLength(3);
    expect(back.chosenConfigId).toBe(decls[2]![1]);
    expect(back.motor).toMatchObject({ designation: 'C6', delay: 3 });
    // The named presets are intact alongside the minted custom set.
    expect(Object.values(back.configs[0]!.motors)[0]!.delay).toBe(5);
    expect(Object.values(back.configs[1]!.motors)[0]!.delay).toBe(7);
  });

  it('writes one notsimulated <simulation> per configuration, tied by configid', () => {
    // The desktop restores EVERY <simulation> (SingleSimulationHandler) and
    // writes one per configuration itself — the old single minted sim meant
    // a seven-config file came back to the desktop with six sims gone.
    const xml = exportOrk({
      name: 'MC', tree: TREE, motors: { b: C6 },
      configs: CONFIGS, activeConfigId: 'cfg-a', launch: LAUNCH,
    });
    const sims = xml.split('<simulation ').slice(1);
    expect(sims).toHaveLength(2);
    expect(sims.map((s) => s.match(/<configid>([^<]+)<\/configid>/)![1]))
      .toEqual(['cfg-a', 'cfg-b']);
    // A renamed configuration's sim reads as itself in the desktop's table;
    // unnamed ones fall back to the desktop's own "Simulation N".
    expect(sims[0]).toContain('<name>Club field C6</name>');
    expect(sims[1]).toContain('<name>Simulation 2</name>');
    for (const s of sims) {
      // The only status/simulator/calculator the desktop loads without warning.
      expect(s.startsWith('status="notsimulated">')).toBe(true);
      expect(s).toContain('<simulator>RK4Simulator</simulator>');
      expect(s).toContain('<calculator>BarrowmanCalculator</calculator>');
    }
    // Our own re-import still recovers the launch conditions.
    expect(importOrk(xml).launch?.windAverage).toBeCloseTo(2, 12);
  });

  it('no configs still writes exactly one simulation (legacy single-sim shape)', () => {
    const xml = exportOrk({ name: 'MC', tree: TREE, motors: { b: C6 }, launch: LAUNCH });
    expect((xml.match(/<simulation /g) ?? []).length).toBe(1);
    expect(xml).toContain('<name>Simulation 1</name>');
  });

  it('no configs supplied still emits exactly one minted configuration (legacy shape)', () => {
    for (const extra of [{}, { configs: [] as OrkExportConfig[], activeConfigId: null }]) {
      const xml = exportOrk({ name: 'MC', tree: TREE, motors: { b: C6 }, ...extra });
      expect((xml.match(/<motorconfiguration /g) ?? []).length).toBe(1);
      expect(xml).toMatch(/<motorconfiguration configid="[0-9a-f-]+" default="true">/);
      expect((xml.match(/<motor configid=/g) ?? []).length).toBe(1);
    }
  });

  it('full round trip: Stage A import → Stage B state → export → re-import (the share-link contract)', () => {
    const orig = importOrk(MULTI);
    const toExport = (m: OrkMotorRef) => ({
      designation: m.designation, manufacturer: m.manufacturer,
      diameter: m.diameter, length: m.length, delay: m.delay,
      ignitionEvent: m.ignitionEvent, ignitionDelay: m.ignitionDelay,
    });
    const mapMotors = (motors: Record<string, OrkMotorRef>) =>
      Object.fromEntries(Object.entries(motors).map(([id, m]) => [id, toExport(m)]));
    const xml = exportOrk({
      name: orig.name, tree: orig.tree,
      motors: mapMotors(orig.motors), // the live working set = the applied config
      configs: orig.configs.map((c) => ({
        id: c.id, name: c.name, isDefault: c.isDefault, motors: mapMotors(c.motors),
      })),
      activeConfigId: orig.chosenConfigId,
    });
    const back = importOrk(xml);
    expect(back.configs.map((c) => ({ id: c.id, name: c.name, isDefault: c.isDefault }))).toEqual([
      { id: 'cfg-a', name: 'Club field C6', isDefault: true },
      { id: 'cfg-b', name: 'Demo day D12', isDefault: false },
    ]);
    // cfg-a (default/active): both mounts, same designations and delays.
    expect(back.chosenConfigId).toBe('cfg-a');
    expect(Object.values(back.motors).map((m) => `${m.designation}-${m.delay}`).sort())
      .toEqual(['C6-5', 'D12-0']);
    // cfg-b preset: the sustainer's D12 with its ignition override intact.
    const b = Object.values(back.configs[1]!.motors);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ designation: 'D12', delay: 7, ignitionEvent: 'launch' });
    expect(b[0]!.ignitionDelay).toBeCloseTo(1.5, 12);
    // Mount keys are the NEW parse's node ids — cfg-b's motor sits on the
    // same mount the applied C6 does.
    expect(back.configs[1]!.motors[back.motor!.mountId!]).toBeDefined();
  });
});

describe('.ork motor identity (desktop three-tier matcher fidelity)', () => {
  // Fixture modeled on the LEM-IV beta file's motor blocks (real AeroTech
  // manufacturer + digest strings, one reload + one single-use): the desktop
  // resolves motors full match > digest-only > description
  // (ThrustCurveMotorSetDatabase.findMotors), and a matching <digest> is the
  // silent-success tier — dropping it (or writing manufacturer 'custom' /
  // a hardcoded <type>single</type>) is what raised "No motor with
  // designation … for manufacturer 'custom' found." on every re-opened save.
  const toExport = (m: OrkMotorRef) => ({
    designation: m.designation, manufacturer: m.manufacturer,
    type: m.motorType, digest: m.digest,
    diameter: m.diameter, length: m.length, delay: m.delay,
    ignitionEvent: m.ignitionEvent, ignitionDelay: m.ignitionDelay,
  });
  const mapMotors = (motors: Record<string, OrkMotorRef>) =>
    Object.fromEntries(Object.entries(motors).map(([id, m]) => [id, toExport(m)]));

  it('reader captures digest, type and manufacturer from a desktop motor block', () => {
    const result = importOrk(golden('lemiv-motors.ork'));
    // Chosen config = file default (the single-use K535).
    expect(result.motor).toMatchObject({
      designation: 'HP-K535W', manufacturer: 'AeroTech',
      motorType: 'single', digest: '74451a159ce1001a76d319ed0d9a6f9a',
      delay: 14,
    });
    const reload = Object.values(result.configs[0]!.motors)[0]!;
    expect(reload).toMatchObject({
      designation: 'M1500G', manufacturer: 'AeroTech',
      motorType: 'reload', digest: '233f8744136b12e764b86fe4430e11e7',
    });
  });

  it('round-trips designation+manufacturer+type+digest in the desktop element order', () => {
    const orig = importOrk(golden('lemiv-motors.ork'));
    const xml = exportOrk({
      name: orig.name, tree: orig.tree, motors: mapMotors(orig.motors),
      configs: orig.configs.map((c) => ({
        id: c.id, name: c.name, isDefault: c.isDefault, motors: mapMotors(c.motors),
      })),
      activeConfigId: orig.chosenConfigId,
    });
    // Desktop element order (RocketComponentSaver): type, manufacturer,
    // digest, designation, diameter, length, delay.
    const blocks = [...xml.matchAll(/<motor configid="[^"]+">[\s\S]*?<\/motor>/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      const order = [...b.matchAll(/<(type|manufacturer|digest|designation|diameter|length|delay)>/g)]
        .map((m) => m[1]);
      expect(order).toEqual(['type', 'manufacturer', 'digest', 'designation', 'diameter', 'length', 'delay']);
    }
    const back = importOrk(xml);
    expect(back.motor).toMatchObject({
      designation: 'HP-K535W', manufacturer: 'AeroTech',
      motorType: 'single', digest: '74451a159ce1001a76d319ed0d9a6f9a', delay: 14,
    });
    const reload = Object.values(back.configs.find((c) => !c.isDefault)!.motors)[0]!;
    expect(reload).toMatchObject({
      designation: 'M1500G', manufacturer: 'AeroTech',
      motorType: 'reload', digest: '233f8744136b12e764b86fe4430e11e7',
    });
  });

  it('omits type/manufacturer/digest when unknown — never "custom", never a minted "single"', () => {
    // A mfr-less file reads back manufacturer 'unknown' (our reader's
    // sentinel) — the writer must OMIT it: null skips the desktop's
    // description filter, while 'custom'/'unknown' fails every match.
    const BARE = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
      <name>Bare</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
        <motormount><ignitionevent>automatic</ignitionevent>
          <motor configid="x"><designation>X100</designation>
            <diameter>0.024</diameter><length>0.07</length><delay>5.0</delay></motor>
        </motormount>
      </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    const orig = importOrk(BARE);
    expect(orig.motor?.digest).toBeUndefined();
    expect(orig.motor?.motorType).toBeUndefined();
    const xml = exportOrk({
      name: orig.name, tree: orig.tree, motor: toExport(orig.motor!),
      mountId: orig.motor?.mountId,
    });
    const mount = xml.match(/<motormount>[\s\S]*?<\/motormount>/)![0];
    expect(mount).not.toContain('<type>');
    expect(mount).not.toContain('<manufacturer>');
    expect(mount).not.toContain('<digest>');
    expect(mount).not.toContain('custom');
    expect(mount).toContain('<designation>X100</designation>');
  });

  it('plugged (Infinity) still writes <delay>none</delay> alongside the identity fields', () => {
    const orig = importOrk(golden('lemiv-motors.ork'));
    const ref = orig.motor!;
    const xml = exportOrk({
      name: 'P', tree: orig.tree,
      motors: { [ref.mountId!]: { ...toExport(ref), delay: Infinity } },
    });
    expect(xml).toContain('<delay>none</delay>');
    const back = importOrk(xml);
    expect(back.motor?.delay).toBe(Infinity);
    expect(back.motor?.digest).toBe('74451a159ce1001a76d319ed0d9a6f9a');
  });

  it('captures <digest> only from format 1.4+ files — a 1.3 digest is the old algorithm', () => {
    // The desktop only honours digests from files saved at format 1.4 on
    // (the algorithm changed there). Carrying a 1.2/1.3 digest into our
    // version="1.10" wrapper would make the desktop trust a digest it would
    // itself have ignored → spurious "differing thrust curve" warnings.
    // NOTE the trap the parse must dodge: Number("1.10") is 1.1 < 1.4.
    const withVersion = (v: string) => `<openrocket version="${v}" creator="OpenRocket"><rocket>
      <name>V</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
        <motormount><ignitionevent>automatic</ignitionevent>
          <motor configid="x"><type>single</type><manufacturer>AeroTech</manufacturer>
            <digest>74451a159ce1001a76d319ed0d9a6f9a</digest>
            <designation>HP-K535W</designation>
            <diameter>0.054</diameter><length>0.404</length><delay>14.0</delay></motor>
        </motormount>
      </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    const old = importOrk(withVersion('1.3')).motor!;
    expect(old.digest).toBeUndefined();
    // <type>/<manufacturer> are version-independent — still captured.
    expect(old.motorType).toBe('single');
    expect(old.manufacturer).toBe('AeroTech');
    const modern = importOrk(withVersion('1.10')).motor!;
    expect(modern.digest).toBe('74451a159ce1001a76d319ed0d9a6f9a');
  });

  it('EX motor with the "EX" sentinel manufacturer exports with <manufacturer> omitted', () => {
    // toExportMotor resolves an EX motor's real manufacturer from the local
    // library; an .rse with no mfg attribute stores the 'EX' display badge,
    // which toExportMotor maps to undefined at the export boundary — the
    // desktop has no manufacturer literally named EX, and omission lets its
    // designation-only description match still find the motor.
    const orig = importOrk(golden('lemiv-motors.ork'));
    const ref = orig.motor!;
    const xml = exportOrk({
      name: 'EX', tree: orig.tree,
      motors: {
        [ref.mountId!]: {
          designation: 'K550-EX', manufacturer: undefined,
          diameter: 0.054, length: 0.404, delay: 10,
        },
      },
    });
    const mount = xml.match(/<motormount>[\s\S]*?<\/motormount>/)![0];
    expect(mount).not.toContain('<manufacturer>');
    expect(mount).toContain('<designation>K550-EX</designation>');
  });
});

describe('.ork mass-component type round trip', () => {
  const ALTIMETER = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Alt</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
        <subcomponents>
          <masscomponent><name>Alt1</name><packedlength>0.02</packedlength>
            <packedradius>0.005</packedradius><mass>0.02</mass>
            <masscomponenttype>altimeter</masscomponenttype></masscomponent>
        </subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;

  it('preserves a non-default masscomponenttype through import and export', () => {
    const result = importOrk(ALTIMETER);
    const mc = flatten(result.tree.components).find((c) => c.type === 'masscomponent')!;
    expect(mc['massComponentType']).toBe('altimeter');
    const xml = exportOrk({ name: result.name, tree: result.tree });
    expect(xml).toContain('<masscomponenttype>altimeter</masscomponenttype>');
    const back = importOrk(xml);
    const mc2 = flatten(back.tree.components).find((c) => c.type === 'masscomponent')!;
    expect(mc2['massComponentType']).toBe('altimeter');
  });

  it('defaults to masscomponent when the node carries no type', () => {
    const tree = {
      name: 'M',
      components: [{
        type: 'stage' as const, name: 'S',
        children: [{
          type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          children: [{ type: 'masscomponent' as const, mass: 0.05 }],
        }],
      }],
    };
    const xml = exportOrk({ name: 'M', tree });
    expect(xml).toContain('<masscomponenttype>masscomponent</masscomponenttype>');
    // The default is NOT stored on the node (sparse, like finish/crosssection).
    const mc = flatten(importOrk(xml).tree.components).find((c) => c.type === 'masscomponent')!;
    expect(mc['massComponentType']).toBeUndefined();
  });
});

describe('.ork transition shapeclipped preserve-through', () => {
  const CLIPPED_OFF = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Clip</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
      <transition><name>T</name><length>0.05</length><thickness>0.002</thickness>
        <shape>haack</shape><shapeclipped>false</shapeclipped><shapeparameter>0.0</shapeparameter>
        <foreradius>0.012</foreradius><aftradius>0.009</aftradius></transition>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;

  it('preserves an explicit shapeclipped=false on a clippable shape', () => {
    const result = importOrk(CLIPPED_OFF);
    const tr = flatten(result.tree.components).find((c) => c.type === 'transition')!;
    expect(tr['clipped']).toBe(false);
    const xml = exportOrk({ name: result.name, tree: result.tree });
    expect(xml).toContain('<shapeclipped>false</shapeclipped>');
    const back = importOrk(xml);
    expect(flatten(back.tree.components).find((c) => c.type === 'transition')!['clipped']).toBe(false);
  });

  it('omits shapeclipped for non-clippable shapes, like the desktop saver', () => {
    const tree = {
      name: 'NC',
      components: [{
        type: 'stage' as const, name: 'S',
        children: [
          { type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
          { type: 'transition' as const, length: 0.05, thickness: 0.002, shape: 'conical', foreRadius: 0.012, aftRadius: 0.009 },
        ],
      }],
    };
    const xml = exportOrk({ name: 'NC', tree });
    const trXml = xml.match(/<transition>[\s\S]*?<\/transition>/)![0];
    expect(trXml).not.toContain('<shapeclipped>');
    // Round trip: no clipped field is invented on the way back in.
    const tr = flatten(importOrk(xml).tree.components).find((c) => c.type === 'transition')!;
    expect(tr['clipped']).toBeUndefined();
  });

  it('writes the kernel default (clipped) for a clippable shape with no field', () => {
    const tree = {
      name: 'CD',
      components: [{
        type: 'stage' as const, name: 'S',
        children: [
          { type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
          { type: 'transition' as const, length: 0.05, thickness: 0.002, shape: 'haack', foreRadius: 0.012, aftRadius: 0.009 },
        ],
      }],
    };
    const xml = exportOrk({ name: 'CD', tree });
    const trXml = xml.match(/<transition>[\s\S]*?<\/transition>/)![0];
    expect(trXml).toContain('<shapeclipped>true</shapeclipped>');
  });
});

/**
 * Stage-level overrides (beta thread, 2026-08-22). Desktop OpenRocket writes
 * <overridemass> straight under <stage> for the very common "I weighed the
 * whole rocket" case — atestani's posted LEM-M2B.ork does exactly that, and we
 * imported 8.9 % heavy with the CG 31 mm aft because the stage builder never
 * read them. The export side never wrote them either, so once the kernel
 * honoured stage overrides, one typed in the app was applied to the simulation
 * and then thrown away on Save.
 */
describe('.ork stage-level overrides', () => {
  const staged = (inner: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>S</name><subcomponents><stage><name>Stage</name>
      ${inner}
      <subcomponents>
        <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;

  it('reads mass, CG and Cd overrides and their subcomponent flags off <stage>', () => {
    const st = importOrk(staged(`
      <overridemass>0.67471864978</overridemass>
      <overridesubcomponentsmass>true</overridesubcomponentsmass>
      <overridecg>0.5588</overridecg>
      <overridesubcomponentscg>true</overridesubcomponentscg>
      <overridecd>0.45</overridecd>
      <overridesubcomponentscd>false</overridesubcomponentscd>`)).tree.components[0]!;

    expect(st.type).toBe('stage');
    expect(st['overrideMass']).toBeCloseTo(0.67471864978, 12);
    expect(st['overrideSubcomponentsMass']).toBe(true);
    expect(st['overrideCGX']).toBeCloseTo(0.5588, 12);
    expect(st['overrideSubcomponentsCG']).toBe(true);
    expect(st['overrideCD']).toBeCloseTo(0.45, 12);
    expect(st['overrideSubcomponentsCD']).toBeUndefined();
    // The stage keeps its own name — reading overrides must not run base().
    expect(st.name).toBe('Stage');
  });

  it('honours the legacy single <overridesubcomponents> flag on a stage', () => {
    const st = importOrk(staged(`
      <overridemass>1.5</overridemass>
      <overridesubcomponents>true</overridesubcomponents>`)).tree.components[0]!;
    expect(st['overrideSubcomponentsMass']).toBe(true);
    expect(st['overrideSubcomponentsCG']).toBe(true);
    expect(st['overrideSubcomponentsCD']).toBe(true);
  });

  it('writes them back, so a whole-rocket Cd survives Save and reopen', () => {
    const tree = {
      name: 'S',
      components: [{
        type: 'stage' as const,
        name: 'Sustainer',
        overrideCD: 0.45,
        overrideSubcomponentsCD: true,
        overrideMass: 2.5,
        overrideSubcomponentsMass: true,
        children: [{ type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
      }],
    };
    const xml = exportOrk({ name: 'S', tree });
    expect(xml).toContain('<overridecd>0.45</overridecd>');
    expect(xml).toContain('<overridesubcomponentscd>true</overridesubcomponentscd>');

    const back = importOrk(xml).tree.components[0]!;
    expect(back['overrideCD']).toBeCloseTo(0.45, 12);
    expect(back['overrideSubcomponentsCD']).toBe(true);
    expect(back['overrideMass']).toBeCloseTo(2.5, 12);
    expect(back['overrideSubcomponentsMass']).toBe(true);
  });

  it('emits nothing for a stage with no overrides (plain designs round-trip unchanged)', () => {
    const xml = exportOrk({
      name: 'P',
      tree: {
        name: 'P',
        components: [{
          type: 'stage' as const, name: 'Sustainer',
          children: [{ type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
        }],
      },
    });
    const stageBlock = /<stage>[\s\S]*?<subcomponents>/.exec(xml)![0];
    expect(stageBlock).not.toContain('<overridemass>');
    expect(stageBlock).not.toContain('<overridecg>');
    expect(stageBlock).not.toContain('<overridecd>');
  });
});

/**
 * Explicit ring / coupler / bulkhead / engine-block radii (beta thread,
 * 2026-08-22). We read neither `<outerradius>` nor `<innerradius>` on these and
 * wrote `auto` back unconditionally, so the author's hand-set dimensions were
 * replaced by our automatic ones at import and destroyed in their own file at
 * Save. On CT-Concep98-External-Fincan.ork that was 77 g of dry mass and 8 mm
 * of CG.
 */
describe('.ork ring and coupler radii', () => {
  const withRings = (rings: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>R</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.3</length><thickness>0.00127</thickness><radius>0.0508</radius>
        <subcomponents>${rings}</subcomponents>
      </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;

  const find = (xml: string, type: string) =>
    flatten(importOrk(xml).tree.components).find((c) => c.type === type)!;

  it('reads an explicit outer radius on all four types', () => {
    const xml = withRings(`
      <tubecoupler><name>TC</name><length>0.2</length><thickness>0.00089</thickness>
        <outerradius>0.04953</outerradius></tubecoupler>
      <bulkhead><name>BH</name><length>0.004775</length>
        <outerradius>0.048641</outerradius></bulkhead>
      <engineblock><name>EB</name><length>0.005</length><thickness>0.001</thickness>
        <outerradius>0.0185</outerradius></engineblock>
      <centeringring><name>CR</name><length>0.0127</length>
        <outerradius>0.050927</outerradius><innerradius>0.0397</innerradius></centeringring>`);
    expect(find(xml, 'tubecoupler')['outerRadius']).toBeCloseTo(0.04953, 9);
    expect(find(xml, 'bulkhead')['outerRadius']).toBeCloseTo(0.048641, 9);
    expect(find(xml, 'engineblock')['outerRadius']).toBeCloseTo(0.0185, 9);
    expect(find(xml, 'centeringring')['outerRadius']).toBeCloseTo(0.050927, 9);
    expect(find(xml, 'centeringring')['innerRadius']).toBeCloseTo(0.0397, 9);
  });

  it('leaves a bare `auto` automatic instead of turning it into a number', () => {
    const xml = withRings(`
      <centeringring><name>CR</name><length>0.0127</length>
        <outerradius>0.050927</outerradius><innerradius>auto</innerradius></centeringring>`);
    const cr = find(xml, 'centeringring');
    expect(cr['outerRadius']).toBeCloseTo(0.050927, 9);
    expect(cr['innerRadius']).toBeUndefined();
  });

  it('writes the numbers back rather than overwriting them with `auto`', () => {
    const xml = withRings(`
      <centeringring><name>CR</name><length>0.0127</length>
        <outerradius>0.050927</outerradius><innerradius>0.0397</innerradius></centeringring>`);
    const out = exportOrk({ name: 'R', tree: importOrk(xml).tree });
    expect(out).toContain('<outerradius>0.050927</outerradius>');
    expect(out).toContain('<innerradius>0.0397</innerradius>');
    const cr = find(out, 'centeringring');
    expect(cr['outerRadius']).toBeCloseTo(0.050927, 9);
    expect(cr['innerRadius']).toBeCloseTo(0.0397, 9);
  });

  it('still writes `auto` when the design has no explicit radius', () => {
    const out = exportOrk({
      name: 'R',
      tree: {
        name: 'R',
        components: [{
          type: 'stage' as const, name: 'S',
          children: [{
            type: 'bodytube' as const, length: 0.3, outerRadius: 0.0508, thickness: 0.00127,
            children: [{ type: 'centeringring' as const, length: 0.0127 }],
          }],
        }],
      },
    });
    expect(out).toContain('<outerradius>auto</outerradius>');
    expect(out).toContain('<innerradius>auto</innerradius>');
  });
});

describe('fin fillet epoxy counts toward mass, so the old honesty note is gone', () => {
  // Before the fillet bridge this reader pushed a note saying masses read light
  // against desktop OpenRocket. The kernel now counts fillet volume the way
  // desktop does (measured: 24.923 g on a 9.525 mm fillet, 3 fins, 40.6 mm body),
  // so the note would be a false alarm.
  const FILLETED = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Filleted</name>
    <motorconfiguration configid="a1" default="true"><stage number="0" active="true"/></motorconfiguration>
    <subcomponents><stage><name>S</name><subcomponents>
      <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius>
        <subcomponents>
          <trapezoidfinset><name>Fins</name><fincount>3</fincount>
            <rootchord>0.05</rootchord><tipchord>0.03</tipchord><sweeplength>0.02</sweeplength>
            <height>0.03</height><thickness>0.003</thickness>
            <filletradius>0.005</filletradius>
            <filletmaterial type="bulk" density="1730.0" group="Custom">Epoxy</filletmaterial>
          </trapezoidfinset>
        </subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents>
  </rocket></openrocket>`;

  it('says nothing about fillets on import', () => {
    expect(importOrk(FILLETED).notes.some((n) => n.includes('fillet'))).toBe(false);
  });

  it('still carries the fillet through to the tree for the kernel to use', () => {
    const fins = flatten(importOrk(FILLETED).tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['filletRadius']).toBeCloseTo(0.005, 12);
    expect(fins['filletDensity']).toBeCloseTo(1730, 9);
  });
});

describe('per-configuration stage separation', () => {
  /**
   * Separation is a per-flight-configuration setting, exactly like motors and
   * recovery deployment. A real posted design (LEM-IV) sets "never" on all
   * seven of its named configurations while the BARE tags under <stage> still
   * say desktop's default "ejection" — and the default configuration declares
   * no block of its own, so it inherits "ejection". Import baked the opened
   * configuration's value into the tree and switching configurations carried
   * motors and chutes but not separation, so every M motor with a 0 s delay
   * blew the stages apart at burnout and lost two thirds of the altitude.
   */
  const TWO_STAGE = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>SepCfg</name>
    <motorconfiguration configid="cfg-a" default="true"><stage number="0" active="true"/><stage number="1" active="true"/></motorconfiguration>
    <motorconfiguration configid="cfg-b"><stage number="0" active="true"/><stage number="1" active="true"/></motorconfiguration>
    <subcomponents>
      <stage><name>Sustainer</name><subcomponents>
        <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
          <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
      </subcomponents></stage>
      <stage><name>Booster</name>
        <separationevent>ejection</separationevent>
        <separationaltitude>200.0</separationaltitude>
        <separationdelay>0.0</separationdelay>
        <separationconfiguration configid="cfg-b">
          <separationevent>never</separationevent>
          <separationaltitude>200.0</separationaltitude>
          <separationdelay>0.0</separationdelay>
        </separationconfiguration>
        <subcomponents>
          <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket></openrocket>`;

  it('records every configuration’s separation, not just the opened one', () => {
    const r = importOrk(TWO_STAGE);
    const boosterId = r.tree.components[1]!.id!;
    const a = r.configs.find((c) => c.id === 'cfg-a')!;
    const b = r.configs.find((c) => c.id === 'cfg-b')!;
    // cfg-a declares no block: it inherits the bare desktop default.
    expect(a.separations[boosterId]?.separationEvent).toBe('ejection');
    // cfg-b says never, and that must survive being opened on cfg-a.
    expect(b.separations[boosterId]?.separationEvent).toBe('never');
  });

  it('a save under one configuration keeps the OTHERS’ separation', () => {
    // The mirror of the recovery-deployment guarantee. The writer used to emit
    // the LIVE tree's separation into every <separationconfiguration>, so
    // saving while cfg-a was open rewrote cfg-b from "never" to "ejection" —
    // and a design whose whole point is that it does not come apart came back
    // separating at its motor's ejection charge.
    const openedA = importOrk(TWO_STAGE, { configId: 'cfg-a' });
    const xml = exportOrk({
      name: 'SepCfg', tree: openedA.tree, motors: {},
      configs: openedA.configs.map((c) => ({
        id: c.id, name: c.name, isDefault: c.isDefault, motors: {},
        deployments: c.deployments, separations: c.separations,
      })),
      activeConfigId: 'cfg-a',
    });
    expect(importOrk(xml, { configId: 'cfg-b' }).tree.components[1]!['separationEvent'])
      .toBe('never');
    // ...and cfg-a still flies the way it did.
    expect(importOrk(xml, { configId: 'cfg-a' }).tree.components[1]!['separationEvent'])
      .toBeUndefined();
  });

  it('still bakes the OPENED configuration’s separation into the tree', () => {
    expect(importOrk(TWO_STAGE, { configId: 'cfg-b' }).tree.components[1]!['separationEvent'])
      .toBe('never');
    // "ejection" is the kernel default, so cfg-a leaves the field unset.
    expect(importOrk(TWO_STAGE, { configId: 'cfg-a' }).tree.components[1]!['separationEvent'])
      .toBeUndefined();
  });
});

describe('the file’s simulation time step', () => {
  // Desktop writes <timestep> per simulation and flies it. We dropped it and
  // used the engine's own default, which is 0.06 m of apogee but 0.24 m/s of
  // the reported rod-exit velocity on a real design — enough to stop a tester
  // reproducing his own desktop numbers digit for digit.
  const withStep = (step: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>Step</name>
    <motorconfiguration configid="a1" default="true"><stage number="0" active="true"/></motorconfiguration>
    <subcomponents><stage><name>S</name><subcomponents>
      <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
      <bodytube><name>B</name><length>0.3</length><thickness>0.0005</thickness><radius>0.012</radius></bodytube>
    </subcomponents></stage></subcomponents>
  </rocket>
  <simulations><simulation><conditions>
    <configid>a1</configid>
    <launchrodlength>2.1336</launchrodlength>
    ${step}
  </conditions></simulation></simulations></openrocket>`;

  it('is imported when the file states one', () => {
    expect(importOrk(withStep('<timestep>0.08</timestep>')).launch!.timeStepS).toBeCloseTo(0.08, 12);
  });

  // A step FINER than OpenRocket's own 0.05 default costs multiples of the run
  // time for a difference nobody can read: on the file this came from, 0.01 vs
  // 0.05 moves apogee by 0.020 % and maxMach by 0.015 %. The file's step is a
  // ceiling on an adaptive step, not the step itself. Clamp it, and say so —
  // silently flying 0.01 is what made one beta tester's flights take 40 s.
  it('is clamped up to the engine default when the file asks for something finer', () => {
    const res = importOrk(withStep('<timestep>0.01</timestep>'));
    expect(res.launch!.timeStepS).toBeCloseTo(MIN_IMPORTED_TIME_STEP_S, 12);
    expect(res.notes.join(' ')).toMatch(/0\.01 s time step/);
    expect(res.notes.join(' ')).toMatch(/Launch panel/);
  });

  it('says nothing when the file’s step needs no clamping', () => {
    expect(importOrk(withStep('<timestep>0.05</timestep>')).notes.join(' ')).not.toMatch(/time step/);
  });

  // A design saved from here must reproduce the numbers this app showed —
  // including when it is opened in desktop OpenRocket. Before, the export
  // hard-coded 0.05 regardless of what was flown.
  // A step the user chose HERE must survive save-and-reopen. Clamping our own
  // file's value back up would silently undo their deliberate setting — the
  // whole point of exposing the field is that it is theirs to set.
  it('does NOT clamp a sub-default step in a file this app wrote', () => {
    const tree = { name: 'T', components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.012,
      thickness: 0.001 } as ComponentNode] };
    const xml = exportOrk({ name: 'T', tree, launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.02 } });
    expect(xml).toContain(`creator="${ORK_CREATOR}"`);
    const back = importOrk(xml);
    expect(back.launch!.timeStepS).toBeCloseTo(0.02, 12);
    expect(back.notes.join(' ')).not.toMatch(/time step/);
  });

  // Our creator stamp vouches for the setting's provenance, not the number
  // next to it: a shared file hand-edited to 0.0001 is ~270x the cost of the
  // default — the frozen-tab failure v0.071 shipped to fix — and the panel
  // field can neither display it (it rounds to "0") nor take it back. The
  // panel's own floor holds even for files we wrote.
  it('floors a below-panel-floor step even in a file stamped with our creator', () => {
    const ours = withStep('<timestep>0.0001</timestep>')
      .replace('creator="OpenRocket 24.12"', `creator="${ORK_CREATOR}"`);
    const r = importOrk(ours);
    expect(r.launch!.timeStepS).toBeCloseTo(PANEL_TIME_STEP_FLOOR_S, 12);
    expect(r.notes.join(' ')).toMatch(/0\.0001 s time step/);
  });

  // The clamp note used to say "You can set it back to 0.005 s" — but the
  // panel field rejects anything under its 0.01 floor, so the note promised
  // an action the app refuses. Below the floor, tell the truth instead.
  it('does not promise a foreign sub-floor step back — the panel cannot take it', () => {
    const r = importOrk(withStep('<timestep>0.005</timestep>'));
    expect(r.launch!.timeStepS).toBeCloseTo(MIN_IMPORTED_TIME_STEP_S, 12);
    const joined = r.notes.join(' ');
    expect(joined).toMatch(/0\.005 s time step/);
    expect(joined).not.toMatch(/set it back/);
    // Two limits apply to a foreign sub-floor file — the panel's 0.01 minimum
    // and the 0.05 an import starts at — and naming only the first left the
    // flown 0.05 in the same sentence with nothing to explain it.
    expect(joined).toMatch(/minimum of the Time step field/);
    expect(joined).toMatch(/flown at 0\.05 s instead, the step an imported design starts at/);
  });

  // <timestep> is a raw double: 0.037000000000000005 is a representable value
  // one ULP off 0.037, and interpolating it verbatim printed the bits at the
  // user. The note quotes the number the author meant.
  it('quotes the step as a human number, not the raw double', () => {
    const joined = importOrk(withStep('<timestep>0.037000000000000005</timestep>')).notes.join(' ');
    expect(joined).toContain('0.037 s');
    expect(joined).not.toContain('0.037000000000000005');
  });

  it('still clamps the same value in a file OpenRocket wrote', () => {
    const foreign = withStep('<timestep>0.02</timestep>');
    expect(foreign).toMatch(/creator="OpenRocket/);
    const r = importOrk(foreign);
    expect(r.launch!.timeStepS).toBeCloseTo(MIN_IMPORTED_TIME_STEP_S, 12);
    expect(r.notes.join(' ')).toMatch(/0\.02 s time step/);
  });

  it('exports the step that was actually flown, not a hard-coded default', () => {
    const tree = { name: 'T', components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.012,
      thickness: 0.001 } as ComponentNode] };
    const fine = exportOrk({ name: 'T', tree, launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.02 } });
    expect(fine).toContain('<timestep>0.02</timestep>');
    const blank = exportOrk({ name: 'T', tree, launch: DEFAULT_CONDITIONS });
    expect(blank).toContain(`<timestep>${MIN_IMPORTED_TIME_STEP_S}</timestep>`);
  });

  it('is absent when the file states none, so the engine default applies', () => {
    expect(importOrk(withStep('')).launch!.timeStepS).toBeUndefined();
  });

  it('ignores a nonsensical value rather than flying it', () => {
    expect(importOrk(withStep('<timestep>0</timestep>')).launch!.timeStepS).toBeUndefined();
    expect(importOrk(withStep('<timestep>-1</timestep>')).launch!.timeStepS).toBeUndefined();
  });
});

/**
 * The protuberance component (§7.5e) rides the .ork as an extension element,
 * the same contract `<fairing>` has had since v0.034: our reader round-trips
 * it, desktop OpenRocket warns about the unknown element and skips it.
 */
describe('.ork round-trip of the protuberance extension element', () => {
  const design = (kids: ComponentNode[]) => ({
    name: 'Prot',
    components: [{
      type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.02, thickness: 0.001,
      children: kids,
    } as ComponentNode],
  });

  it('round-trips every field, angles in radians', () => {
    const tree = design([{
      type: 'protuberance', id: 'p1', name: 'Cable tunnel',
      dragClass: 'plate', width: 0.03, height: 0.012, length: 0.25,
      count: 3, plateAngle: Math.PI / 6, mass: 0.045,
      position: { method: 'top', offset: 0.05 },
    } as unknown as ComponentNode]);
    const xml = exportOrk({ name: 'Prot', tree });
    const back = importOrk(xml);
    const p = flatten(back.tree.components).find((c) => (c.type as string) === 'protuberance')!;
    expect(p.name).toBe('Cable tunnel');
    expect(p['dragClass']).toBe('plate');
    expect(p['width']).toBeCloseTo(0.03, 12);
    expect(p['height']).toBeCloseTo(0.012, 12);
    expect(p['length']).toBeCloseTo(0.25, 12);
    expect(p['count']).toBe(3);
    expect(p['plateAngle']).toBeCloseTo(Math.PI / 6, 12); // RADIANS, not degrees
    expect(p['mass']).toBeCloseTo(0.045, 12);
    expect(p.position?.method).toBe('top');
    expect(p.position?.offset).toBeCloseTo(0.05, 12);
    // Only when set: an unused Cd escape hatch writes no element at all.
    expect(p['cdFrontal']).toBeUndefined();
  });

  it('carries an explicit frontal Cd only when one was typed', () => {
    const tree = design([{
      type: 'protuberance', id: 'p1', dragClass: 'streamlined',
      width: 0.02, height: 0.01, length: 0.06, count: 1, mass: 0, cdFrontal: 0.37,
    } as unknown as ComponentNode]);
    const xml = exportOrk({ name: 'Prot', tree });
    expect(xml).toContain('<cdfrontal>0.37</cdfrontal>');
    const p = flatten(importOrk(xml).tree.components)
      .find((c) => (c.type as string) === 'protuberance')!;
    expect(p['cdFrontal']).toBeCloseTo(0.37, 12);
  });

  it('reads a hand-mangled element defensively instead of poisoning the design CD', () => {
    // Everything here is junk a hand-edited (or truncated) file could carry.
    // A NaN width or a negative count would reach the drag model as a NaN CD
    // and take the WHOLE rocket's drag with it, not just this component's.
    const xml = `<openrocket version="1.10" creator="x"><rocket><name>P</name>
      <subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.3</length><thickness>0.001</thickness><radius>0.02</radius>
          <subcomponents>
            <protuberance><name>Bad</name>
              <dragclass>wharrgarbl</dragclass>
              <width>not-a-number</width>
              <height>-0.5</height>
              <count>-4</count>
              <plateangle>99</plateangle>
              <cdfrontal>-2</cdfrontal>
            </protuberance>
          </subcomponents>
        </bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const p = flatten(importOrk(xml).tree.components)
      .find((c) => (c.type as string) === 'protuberance')!;
    expect(p['dragClass']).toBe('streamlinedbase'); // unknown class → the default
    expect(p['width']).toBeCloseTo(0.02, 12); // NaN → default
    expect(p['height']).toBeCloseTo(0.01, 12); // negative → default
    expect(p['count']).toBe(1); // negative → 1
    expect(p['plateAngle']).toBeCloseTo(Math.PI / 2, 12); // clamped to 90°
    expect(p['cdFrontal']).toBeUndefined(); // negative → not an override at all
  });

  it('leaves designs without one byte-identical to before the feature', () => {
    const tree = design([{
      type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.05,
      tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
    } as ComponentNode]);
    expect(exportOrk({ name: 'Prot', tree })).not.toContain('protuberance');
  });
});

/**
 * The automatic-radius importer bug, found 2026-08-25 while running the TRF
 * corpus through the engine (`docs/research/trf-sim-disagreements-2026-08-25.md`
 * §6).
 *
 * OpenRocket 15.03 writes an automatic dimension as a BARE `auto`; 23.09 and
 * later append the value it had just resolved. `num()`'s trailing-token parse
 * survives the second shape and silently takes the 12 mm fallback on the first,
 * so a 6.17-inch airframe imported as three pencil-thin tubes:
 *
 *   Comp_Rocket_V4.ork          CD @ M0.3  1.3550 -> 0.4674, apogee 6,699 -> 10,292 ft
 *                               (desktop OpenRocket stored 10,576 ft in that same file)
 *   Wildman Mach 2 this one.ork CD @ M0.3  1.7929 -> 0.4803, CP 42.16 -> 37.05 in
 *
 * Both are 15.03-era files, which is exactly what a long-standing builder has in
 * their archive. Measured against kernel artifact orkengine.mjs md5
 * bc0c742d0343d36a83e0a213f3159da7.
 */
describe('.ork automatic radii (bare `auto`, OpenRocket 15.03)', () => {
  const parse = (name: string) => {
    const r = importOrk(golden(name));
    return { r, parts: flatten(r.tree.components) };
  };
  const by = (parts: ComponentNode[], nm: string) => parts.find((c) => c.name === nm)!;

  it('resolves a body tube forwards, to the nose cone it sits behind', () => {
    // Comp_Rocket_V4's shape: three chained automatic tubes behind an explicit
    // 0.078359 m nose base. Read as 12 mm they carried 2.9x the drag.
    //
    // The WHOLE chain takes the nose radius, tubes 2 and 3 included — that is
    // 24.12, not a liberty taken here. `38mm Min.ork` in the same corpus was
    // written by OpenRocket 23.09 from exactly this shape (nose aftradius
    // 0.02032, then three chained automatic tubes) and 23.09 saved
    // `auto 0.02032` on all three, not `auto 0.025` on the last two.
    // makeAutoRadii's docblock has the mechanism.
    const { parts } = parse('auto-radius-15.03.ork');
    for (const nm of ['Payload Tube', 'SwitchBand / Ebay Assembly', 'Recovery Tube']) {
      expect(by(parts, nm)['outerRadius'], nm).toBeCloseTo(0.078359, 12);
    }
    // ...and the tube that stated its own radius is untouched.
    expect(by(parts, 'Lower Body Tube')['outerRadius']).toBeCloseTo(0.078359, 12);
  });

  it('resolves a nose cone base radius backwards, past an automatic tube', () => {
    // "Wildman Mach 2 this one.ork": <aftradius>auto</aftradius> on the nose,
    // then an automatic tube, then the Switch Band's stated 0.0282448 m. The
    // nose has to chain THROUGH the automatic tube to reach it — the same walk
    // BodyTube.getRearAutoRadius does.
    const { parts } = parse('auto-radius-nose-15.03.ork');
    expect(by(parts, 'Nose cone')['aftRadius']).toBeCloseTo(0.0282448, 12);
    expect(by(parts, 'NC Straight Wall (integral)')['outerRadius']).toBeCloseTo(0.0282448, 12);
    expect(by(parts, 'Switch Band')['outerRadius']).toBeCloseTo(0.0282448, 12);
    expect(by(parts, 'Airframe')['outerRadius']).toBeCloseTo(0.0282448, 12);
  });

  it('resolves a transition fore radius across the stage boundary', () => {
    // The kernel already got this one right (an absent foreRadius becomes
    // setForeRadiusAutomatic(true)), so the value must not MOVE — but it has to
    // exist, because the schematic, the 3D mesh and the property panel all fall
    // back to a hard 12 mm for a missing radius, and a 2.2-inch transition
    // would draw as a stub (findings-2026-08-22-import-fidelity.md item 6).
    const { parts } = parse('auto-radius-nose-15.03.ork');
    const t = by(parts, 'Transition');
    expect(t['foreRadius']).toBeCloseTo(0.0282448, 12); // last tube of stage 1
    expect(t['aftRadius']).toBeCloseTo(0.039878, 12); // stated, untouched
  });

  it('resolves a mass object packed radius to the cavity it sits in', () => {
    // MassObject.getMaxParentRadius(): a body-tube parent gives its INNER
    // radius. 0.078359 outer - 0.002159 wall.
    const { parts } = parse('auto-radius-15.03.ork');
    expect(by(parts, 'Recovery Hardware')['radius']).toBeCloseTo(0.0762, 12);
  });

  it('leaves the automatic shapes the kernel already handles alone', () => {
    // Rings, tube couplers, bulkheads, engine blocks, tube fins and a recovery
    // device's Cd all have a set...Automatic path in ComponentFactory. Turning
    // those into numbers here would FREEZE a dimension the desktop keeps live.
    const { parts } = parse('auto-radius-15.03.ork');
    const ring = by(parts, 'Motor Ring');
    expect(ring['outerRadius']).toBeUndefined();
    expect(ring['innerRadius']).toBeUndefined();
    expect(by(parts, 'Airframe Main')['cd']).toBeUndefined();
  });

  it('says so in a note, naming the components and the diameter it inferred', () => {
    const { r } = parse('auto-radius-15.03.ork');
    const note = r.notes.find((n) => n.includes('automatic diameter'));
    expect(note).toBeDefined();
    expect(note).toContain('Payload Tube');
    expect(note).toContain('Recovery Hardware');
    expect(note).toContain('156.7 mm'); // 2 x 0.078359 m
    expect(note).toContain('OpenRocket 15.03');
  });

  it('keeps `auto <lastvalue>` on the value the desktop resolved', () => {
    // 23.09+ shape. The trailing token IS the number desktop had just computed,
    // so trusting it reproduces the desktop exactly — and keeps every modern
    // file importing bit-identically to before any of this existed.
    const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
      <name>Modern</name><subcomponents><stage><name>S</name><subcomponents>
        <nosecone><name>N</name><length>0.3</length><thickness>0.001</thickness>
          <shape>ogive</shape><aftradius>auto 0.0508</aftradius></nosecone>
        <bodytube><name>B</name><length>0.9</length><thickness>0.00127</thickness>
          <radius>auto 0.0508</radius></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const r = importOrk(xml);
    const parts = flatten(r.tree.components);
    expect(by(parts, 'N')['aftRadius']).toBeCloseTo(0.0508, 12);
    expect(by(parts, 'B')['outerRadius']).toBeCloseTo(0.0508, 12);
    // Nothing was inferred, so nothing is claimed.
    expect(r.notes.some((n) => n.includes('automatic diameter'))).toBe(false);
  });

  it('falls back to OpenRocket own 25 mm when there is nothing to infer from', () => {
    // Every centreline component automatic and no stated radius anywhere:
    // SymmetricComponent.DEFAULT_RADIUS is what the desktop shows. Say so
    // rather than inventing a 12 mm tube and staying quiet about it.
    const xml = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Nothing</name><subcomponents><stage><name>S</name><subcomponents>
        <nosecone><name>N</name><length>0.3</length><thickness>0.001</thickness>
          <shape>ogive</shape><aftradius>auto</aftradius></nosecone>
        <bodytube><name>B</name><length>0.9</length><thickness>0.00127</thickness>
          <radius>auto</radius></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const r = importOrk(xml);
    const parts = flatten(r.tree.components);
    expect(by(parts, 'N')['aftRadius']).toBeCloseTo(0.025, 12);
    expect(by(parts, 'B')['outerRadius']).toBeCloseTo(0.025, 12);
    const note = r.notes.find((n) => n.includes('no neighbour'));
    expect(note).toBeDefined();
    expect(note).toContain('50 mm');
  });

  it('names the diameter each unresolved component actually got', () => {
    // TWO fallbacks in one file. The centreline takes the desktop's 25 mm
    // SymmetricComponent.DEFAULT_RADIUS; the mass object inside that same
    // unresolved tube takes this reader's 5 mm (autoDim's autoFallback), so
    // MassObject.getMaxParentRadius has nothing to give it either. The note
    // used to print 50 mm for every name on the list, including the mass the
    // importer had built at 10 mm.
    const xml = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Nothing</name><subcomponents><stage><name>S</name><subcomponents>
        <nosecone><name>N</name><length>0.3</length><thickness>0.001</thickness>
          <shape>ogive</shape><aftradius>auto</aftradius></nosecone>
        <bodytube><name>B</name><length>0.9</length><thickness>0.00127</thickness>
          <radius>auto</radius><subcomponents>
            <masscomponent><name>W</name><mass>0.05</mass><packedlength>0.02</packedlength>
              <packedradius>auto</packedradius></masscomponent>
          </subcomponents></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const r = importOrk(xml);
    const parts = flatten(r.tree.components);
    expect(by(parts, 'B')['outerRadius']).toBeCloseTo(0.025, 12);
    expect(by(parts, 'W')['radius']).toBeCloseTo(0.005, 12);
    const note = r.notes.find((n) => n.includes('no neighbour'))!;
    expect(note).toContain('3 components');
    expect(note).toContain('N, B use');
    expect(note).toContain('50 mm default');
    expect(note).toContain('W uses a 10 mm default'); // and NOT 50 mm
  });

  it('does not hang on an automatic chain that points at itself', () => {
    // Two automatic tubes and nothing else: desktop's refComp guard stops the
    // walk; ours is a visited set. Without it this recurses forever.
    const xml = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Cycle</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>A</name><length>0.5</length><thickness>0.001</thickness>
          <radius>auto</radius></bodytube>
        <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness>
          <radius>auto</radius></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const parts = flatten(importOrk(xml).tree.components);
    expect(by(parts, 'A')['outerRadius']).toBeCloseTo(0.025, 12);
    expect(by(parts, 'B')['outerRadius']).toBeCloseTo(0.025, 12);
  });

  it('warns instead of copying the desktop 0 for a tube ahead of a nose cone', () => {
    // The deliberate deviation from 24.12 (see the comment on `rear` in
    // makeAutoRadii). An un-flipped nose cone's fore radius is 0 and not
    // automatic, so Transition.getRearAutoRadius returns 0, and 0 is not < 0 —
    // the desktop gives this tube a ZERO radius. 25 mm and a note is the honest
    // answer for a design this degenerate; pin it so nobody "restores parity".
    const xml = `<openrocket version="1.4" creator="OpenRocket 15.03"><rocket>
      <name>Backwards</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness>
          <radius>auto</radius></bodytube>
        <nosecone><name>N</name><length>0.3</length><thickness>0.001</thickness>
          <shape>ogive</shape><aftradius>0.05</aftradius></nosecone>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const r = importOrk(xml);
    const parts = flatten(r.tree.components);
    expect(by(parts, 'B')['outerRadius']).toBeCloseTo(0.025, 12);
    expect(r.notes.some((n) => n.includes('no neighbour'))).toBe(true);
  });

  it('drops an unparseable <cd> instead of storing NaN', () => {
    // Same family: `Number("auto 0.8")` is NaN, and a NaN drag coefficient
    // reaches the descent solver.
    const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
      <name>Cd</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness><radius>0.03</radius>
          <subcomponents>
            <parachute><name>Auto</name><diameter>0.6</diameter><cd>auto</cd></parachute>
            <parachute><name>Junk</name><diameter>0.6</diameter><cd>auto 0.8</cd></parachute>
            <parachute><name>Real</name><diameter>0.6</diameter><cd>0.97</cd></parachute>
            <streamer><name>Strip</name><striplength>0.5</striplength><stripwidth>0.05</stripwidth>
              <cd>auto</cd></streamer>
          </subcomponents>
        </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    const parts = flatten(importOrk(xml).tree.components);
    expect(by(parts, 'Auto')['cd']).toBeUndefined();
    expect(by(parts, 'Junk')['cd']).toBeUndefined();
    expect(by(parts, 'Real')['cd']).toBeCloseTo(0.97, 12);
    expect(by(parts, 'Strip')['cd']).toBeUndefined();
  });

  it('flies the resolved design instead of a 12 mm pencil', async () => {
    // End to end through the kernel on the fixture's own geometry: the
    // reference diameter, and the drag it implies, are what moved.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const r = OrkRocket.buildTree(engineTree(importOrk(golden('auto-radius-15.03.ork')).tree));
    const info = r.staticInfo();
    // 2 x 0.078359 m = 6.17 in, the airframe the author drew — not 24 mm.
    expect(info.refDiameter).toBeCloseTo(0.156718, 6);
    const sweep = r.dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 0.1, aoaDeg: 0 });
    expect(sweep.powerOff.total[0]!).toBeLessThan(0.6); // 1.3550 before the fix
  });
});

/**
 * `<flightdata>` — option (c) from the 2026-08-26 batch: write the flight WE
 * computed into the saved `.ork`, guarded.
 *
 * The two rejected alternatives are worth remembering, because they are what
 * every assertion here is defending against. Copying the ORIGINAL file's
 * blocks looks seamless and lies the moment anything changes — desktop would
 * show a result computed from a design that no longer exists with nothing on
 * screen saying so. Writing nothing leaves a user who saves here and opens in
 * desktop looking at their configurations with every result blank.
 *
 * The exporter therefore writes results only where the CALLER vouches for
 * them, and writes `notsimulated` everywhere else.
 */
describe('exportOrk — <flightdata>', () => {
  const TREE = {
    name: 'MC',
    components: [{
      type: 'stage' as const, id: 's', name: 'Sustainer',
      children: [{
        type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012,
        thickness: 0.0005, motorMount: true,
      }],
    }],
  };
  const LAUNCH = {
    launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 2, windStdDev: 0.2,
    launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 28.61,
  };
  const cfg = (id: string, name: string): OrkExportConfig =>
    ({ id, name, isDefault: id === 'cfgA', motors: {} });
  const base = () => ({
    name: 'R', tree: TREE, launch: LAUNCH,
    configs: [cfg('cfgA', 'Club field'), cfg('cfgB', 'Demo day')],
    activeConfigId: 'cfgA',
  });
  const sims = (xml: string) => xml.split('<simulation ').slice(1);

  it('with no flightData the file is exactly what it always was', () => {
    const xml = exportOrk(base());
    expect(xml).not.toContain('<flightdata');
    for (const s of sims(xml)) expect(s.startsWith('status="notsimulated">')).toBe(true);
  });

  it('writes results for the vouched-for configuration and nothing for the other', () => {
    const xml = exportOrk({
      ...base(),
      flightData: { cfgA: { maxAltitude: 331.7, maxVelocity: 116.2 } },
    });
    const [a, b] = sims(xml);
    expect(a!.startsWith('status="uptodate">')).toBe(true);
    expect(a).toContain('<flightdata maxaltitude="331.7" maxvelocity="116.2"/>');
    // The unvouched one says the true thing: we have not run it.
    expect(b!.startsWith('status="notsimulated">')).toBe(true);
    expect(b).not.toContain('<flightdata');
  });

  it('uses the desktop’s own attribute spellings, in its own order', () => {
    // maxmach (not maxmachnumber), optimumdelay, all lowercase, no separators
    // — DocumentConfig's attribute lookup is exact.
    const xml = exportOrk({
      ...base(),
      flightData: {
        cfgA: {
          maxAltitude: 1, maxVelocity: 2, maxAcceleration: 3, maxMach: 4,
          timeToApogee: 5, flightTime: 6, groundHitVelocity: 7,
          launchRodVelocity: 8, deploymentVelocity: 9, optimumDelay: 10,
        },
      },
    });
    expect(xml).toContain('<flightdata maxaltitude="1" maxvelocity="2" maxacceleration="3"'
      + ' maxmach="4" timetoapogee="5" flighttime="6" groundhitvelocity="7"'
      + ' launchrodvelocity="8" deploymentvelocity="9" optimumdelay="10"/>');
  });

  it('skips a non-finite value rather than serializing it', () => {
    // The desktop's saver appends each attribute only when it is not NaN, and
    // our own emit interpolates raw — "NaN" or "null" in the file would be a
    // number desktop's reader silently turns into NaN anyway.
    const xml = exportOrk({
      ...base(),
      flightData: { cfgA: { maxAltitude: 100, maxVelocity: NaN, maxMach: Infinity, timeToApogee: null } },
    });
    expect(xml).toContain('<flightdata maxaltitude="100"/>');
    expect(xml).not.toMatch(/NaN|Infinity|null/);
  });

  it('an entry with nothing finite in it writes NO element and stays notsimulated', () => {
    // A zero-attribute <flightdata> would still build an all-NaN FlightData in
    // desktop and mark the simulation "loaded" — nine blank columns claiming
    // to be a result.
    const xml = exportOrk({ ...base(), flightData: { cfgA: { maxAltitude: NaN } } });
    expect(xml).not.toContain('<flightdata');
    expect(sims(xml)[0]!.startsWith('status="notsimulated">')).toBe(true);
  });

  it('sits after </conditions> and inside </simulation>, where desktop puts it', () => {
    const xml = exportOrk({ ...base(), flightData: { cfgA: { maxAltitude: 1 } } });
    const s = sims(xml)[0]!;
    const cond = s.indexOf('</conditions>');
    const fd = s.indexOf('<flightdata');
    const end = s.indexOf('</simulation>');
    expect(cond).toBeGreaterThan(-1);
    expect(fd).toBeGreaterThan(cond);
    expect(end).toBeGreaterThan(fd);
  });

  it('does not disturb the round trip — our own reader ignores it', () => {
    const xml = exportOrk({
      ...base(),
      launch: { ...LAUNCH, windAverage: 4.5, launchRodAngleDeg: 7 },
      flightData: { cfgA: { maxAltitude: 331.7 } },
    });
    const back = importOrk(xml);
    expect(back.launch?.windAverage).toBeCloseTo(4.5, 6);
    expect(back.launch?.launchRodAngleDeg).toBeCloseTo(7, 6);
    expect(back.configs?.map((c) => c.id)).toEqual(['cfgA', 'cfgB']);
  });
});

describe('exportOrk — results for a design with no flight configurations', () => {
  // A design built in the app carries none, so the writer mints one with a
  // fresh id on every export and the caller has no stable key to use. Without
  // the default channel the whole feature would only ever work for designs
  // opened from a file that already had configurations — which is not what the
  // guide says and not what most people have.
  const TREE = {
    name: 'MC',
    components: [{
      type: 'stage' as const, id: 's', name: 'Sustainer',
      children: [{
        type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.012,
        thickness: 0.0005, motorMount: true,
      }],
    }],
  };
  const LAUNCH = {
    launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 2, windStdDev: 0.2,
    launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 28.61,
  };

  it('writes them onto the single minted simulation', () => {
    const xml = exportOrk({
      name: 'R', tree: TREE, launch: LAUNCH,
      flightDataDefault: { maxAltitude: 331.7 },
    });
    expect(xml).toContain('<simulation status="uptodate">');
    expect(xml).toContain('<flightdata maxaltitude="331.7"/>');
  });

  it('still writes nothing when there is nothing to write', () => {
    const xml = exportOrk({ name: 'R', tree: TREE, launch: LAUNCH });
    expect(xml).toContain('<simulation status="notsimulated">');
    expect(xml).not.toContain('<flightdata');
  });

  it('the keyed map wins over the default for a config that has its own', () => {
    const cfgs: OrkExportConfig[] = [
      { id: 'cfgA', name: 'A', isDefault: true, motors: {} },
      { id: 'cfgB', name: 'B', isDefault: false, motors: {} },
    ];
    const xml = exportOrk({
      name: 'R', tree: TREE, launch: LAUNCH, configs: cfgs, activeConfigId: 'cfgA',
      flightData: { cfgA: { maxAltitude: 1 } },
      flightDataDefault: { maxAltitude: 999 },
    });
    expect(xml).toContain('<flightdata maxaltitude="1"/>');
    expect(xml).not.toContain('999');
  });
});

describe('flightDataAttrs — the guard against an empty block', () => {
  it('is null for absent input and for an all-non-finite one', () => {
    expect(flightDataAttrs(undefined)).toBeNull();
    expect(flightDataAttrs({})).toBeNull();
    expect(flightDataAttrs({ maxAltitude: NaN, maxVelocity: null })).toBeNull();
  });

  it('emits only the finite values', () => {
    expect(flightDataAttrs({ maxAltitude: 0, maxVelocity: NaN }))
      .toBe('maxaltitude="0"');
  });
});
