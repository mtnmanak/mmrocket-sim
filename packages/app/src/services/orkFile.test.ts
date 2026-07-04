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

  it('reports body-tube mounts and unknown component types', () => {
    const result = importOrk(BODY_MOUNT);
    expect(result.motor?.designation).toBe('D12');
    expect(result.motor?.mountId).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/Motor mounts directly/);
    expect(result.ignored).toContain('podset');
    // freeformfinset is now supported — it imports rather than being ignored.
    expect(result.ignored).not.toContain('freeformfinset');
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
