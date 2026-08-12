// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { GLB_MIME, rocketToGlb } from './gltfExport.js';

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

  it('rejects an empty design', async () => {
    await expect(rocketToGlb({ components: [{ type: 'stage', children: [] }] } as RocketTree, 'X'))
      .rejects.toThrow(/Nothing to export/);
  });

  it('exposes the download MIME type', () => {
    expect(GLB_MIME).toBe('model/gltf-binary');
  });
});
