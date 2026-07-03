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

describe('.ork tree import', () => {
  it('imports the reference golden file with structure preserved', () => {
    const result = importOrk(golden('reference.ork'));

    expect(result.name).toBe('Reference Rocket');
    expect(result.tree.components.map((c) => c.type)).toEqual(['nosecone', 'bodytube']);
    const body = result.tree.components[1]!;
    expect((body.children ?? []).map((c) => c.type)).toEqual([
      'trapezoidfinset', 'innertube', 'parachute',
    ]);
    const mount = body.children![1]!;
    expect(mount['motorMount']).toBe(true);
    expect(result.motor?.designation).toBe('C6');
    expect(result.motor?.mountId).toBe(mount.id);
    expect(result.ignored).toEqual([]);
  });

  it('imports the kitchen-sink golden file — all 17 component types', () => {
    const result = importOrk(golden('kitchensink.ork'));

    const types = flatten(result.tree.components).map((c) => c.type);
    for (const t of [
      'nosecone', 'masscomponent', 'bodytube', 'ellipticalfinset', 'launchlug',
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
    expect(result.ignored).toContain('freeformfinset');
    expect(result.ignored).toContain('podset');
  });

  it('accepts bare XML delivered as an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode(BODY_MOUNT);
    const buf = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
    expect(importOrk(buf).name).toBe('MinDia');
  });
});
