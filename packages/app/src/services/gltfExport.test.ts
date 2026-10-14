// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { rocketToGlb } from './gltfExport.js';

const tree: RocketTree = {
  name: 'GlbTest',
  components: [{
    type: 'stage', id: 's', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.012, shape: 'ogive' } as ComponentNode,
      { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012 } as ComponentNode,
    ],
  } as ComponentNode],
};

const u32 = (buf: ArrayBuffer, off: number): number => new DataView(buf).getUint32(off, true);

describe('rocketToGlb', () => {
  it('emits a valid GLB container with colored materials', async () => {
    const glb = await rocketToGlb(tree, 'GlbTest');
    expect(glb).toBeInstanceOf(ArrayBuffer);

    // GLB header: magic 'glTF', version 2, total length (all LE uint32).
    expect(u32(glb, 0)).toBe(0x46546c67);
    expect(u32(glb, 4)).toBe(2);
    expect(u32(glb, 8)).toBe(glb.byteLength);

    // First chunk is JSON ('JSON' = 0x4E4F534A).
    const jsonLen = u32(glb, 12);
    expect(u32(glb, 16)).toBe(0x4e4f534a);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
    expect(json.meshes.length).toBeGreaterThanOrEqual(2);
    expect(json.materials.length).toBeGreaterThanOrEqual(1);
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toBeDefined();

    // Piece keys and the rocket name survive as node names.
    const names = (json.nodes ?? []).map((n: { name?: string }) => n.name ?? '');
    expect(names).toContain('GlbTest');
    expect(names.some((n: string) => n.startsWith('nose'))).toBe(true);
    expect(names.some((n: string) => n.startsWith('body'))).toBe(true);

    // A BIN chunk ('BIN\0' = 0x004E4942) follows the JSON chunk.
    const binOff = 20 + jsonLen;
    expect(u32(glb, binOff + 4)).toBe(0x004e4942);
    expect(u32(glb, binOff)).toBeGreaterThan(0);
  });

  it('is the EXTERNAL shell: a motor mount inside the body tube is not in the file', async () => {
    // The 3D view draws inner tubes as glass through the shell, and the .glb
    // used to carry them too (audit 2026-09-22).
    const withMount: RocketTree = {
      ...tree,
      components: [{
        type: 'stage', id: 's', name: 'Sustainer',
        children: [
          { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.012, shape: 'ogive' } as ComponentNode,
          { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, children: [
            { type: 'innertube', id: 'mm', length: 0.1, outerRadius: 0.0065, position: { method: 'bottom', offset: 0 } },
          ] } as unknown as ComponentNode,
        ],
      } as ComponentNode],
    };
    const glb = await rocketToGlb(withMount, 'GlbTest');
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, u32(glb, 12))));
    const names = (json.nodes ?? []).map((n: { name?: string }) => n.name ?? '');
    expect(names.some((n: string) => n.startsWith('body'))).toBe(true);
    expect(names.filter((n: string) => n.startsWith('inner'))).toEqual([]);
  });

  it('carries each part’s surface finish as roughness and metalness (N062)', async () => {
    // The 3D view's own map (pieces.ts FINISH_MATERIAL): Mirror is glossy,
    // Rough is matte, and a part with no finish keeps Regular paint's 0.6 / 0.05.
    const finished: RocketTree = {
      ...tree,
      components: [{
        type: 'stage', id: 's', name: 'Sustainer',
        children: [
          { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.012, shape: 'ogive', finish: 'mirror' } as ComponentNode,
          { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, finish: 'rough', children: [
            { type: 'trapezoidfinset', id: 'f', finCount: 1, rootChord: 0.05, tipChord: 0.03, sweep: 0.02,
              height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } },
          ] } as unknown as ComponentNode,
        ],
      } as ComponentNode],
    };
    const glb = await rocketToGlb(finished, 'GlbTest');
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, u32(glb, 12)))) as {
      nodes: { name?: string; mesh?: number }[];
      meshes: { primitives: { material: number }[] }[];
      materials: { pbrMetallicRoughness: { roughnessFactor?: number; metallicFactor?: number } }[];
    };
    const pbrOf = (prefix: string) => {
      const node = json.nodes.find((n) => n.name?.startsWith(prefix))!;
      return json.materials[json.meshes[node.mesh!]!.primitives[0]!.material]!.pbrMetallicRoughness;
    };
    expect(pbrOf('nose').roughnessFactor).toBeCloseTo(0.08, 6);
    expect(pbrOf('nose').metallicFactor).toBeCloseTo(0.25, 6);
    expect(pbrOf('body').roughnessFactor).toBeCloseTo(0.95, 6);
    expect(pbrOf('fin').roughnessFactor).toBeCloseTo(0.6, 6);
    expect(pbrOf('fin').metallicFactor).toBeCloseTo(0.05, 6);
  });

  it('rejects an empty design', async () => {
    await expect(rocketToGlb({ components: [{ type: 'stage', children: [] }] } as RocketTree, 'X'))
      .rejects.toThrow(/Nothing to export/);
  });
});
