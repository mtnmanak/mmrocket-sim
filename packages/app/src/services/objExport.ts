import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { RocketTree } from '@online-openrocket/engine';
import { buildPieces } from '../components/Rocket3D.js';

/**
 * Wavefront OBJ export of the rocket's EXTERNAL 3D geometry — the same
 * meshes the 3D view renders (lathe nose profiles, tubes, transitions,
 * extruded fins at their instance angles; internals are not part of the
 * visible shell). Units are METERS; scale on import (most slicers ask).
 * Meant for print-preview/display models and CAD reference — it is surface
 * geometry, not a guaranteed-watertight solid.
 */
export function rocketToObj(tree: RocketTree, name: string): string {
  const { pieces, totalLen } = buildPieces(tree);
  if (pieces.length === 0) {
    throw new Error('Nothing to export — the design has no external components.');
  }
  const group = new THREE.Group();
  for (const p of pieces) {
    const mesh = new THREE.Mesh(p.geometry);
    mesh.name = p.key;
    if (p.position) mesh.position.set(...p.position);
    if (p.rotation) mesh.rotation.set(...p.rotation);
    group.add(mesh);
  }
  group.updateMatrixWorld(true);
  const obj = new OBJExporter().parse(group);
  return [
    `# Online OpenRocket — ${name}`,
    '# Units: METERS (rocket axis = +X, nose tip at x=0)',
    `# Overall length: ${(totalLen * 1000).toFixed(1)} mm`,
    obj,
  ].join('\n');
}
