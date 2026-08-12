import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RocketTree } from '@online-openrocket/engine';
import { buildPieces } from '../components/Rocket3D.js';

/**
 * Binary glTF (.glb) export of the rocket's EXTERNAL 3D geometry — the same
 * meshes the 3D view renders, each carrying its app color as a
 * MeshStandardMaterial (the advantage over .obj, which is geometry-only).
 * glTF is METERS by spec, so our SI geometry passes through unscaled; the
 * rocket axis = +X with the nose tip at the origin, matching the .obj export
 * (viewers show the rocket lying on its side — that is fine).
 */

export const GLB_MIME = 'model/gltf-binary';

export function rocketToGlb(tree: RocketTree, name: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const { pieces } = buildPieces(tree);
    if (pieces.length === 0) {
      reject(new Error('Nothing to export — the design has no external components.'));
      return;
    }
    const group = new THREE.Group();
    group.name = name;
    for (const p of pieces) {
      const mesh = new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({
        color: p.color, roughness: 0.6, metalness: 0.05,
      }));
      mesh.name = p.key;
      if (p.position) mesh.position.set(...p.position);
      if (p.rotation) mesh.rotation.set(...p.rotation);
      group.add(mesh);
    }
    group.updateMatrixWorld(true);
    new GLTFExporter().parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('glTF export did not produce a binary (.glb) buffer.'));
      },
      (err) => reject(err instanceof Error ? err : new Error(`glTF export failed: ${String(err)}`)),
      { binary: true },
    );
  });
}
