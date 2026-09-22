import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { RocketTree } from '@online-openrocket/engine';
import { buildPieces, isShellPiece } from '../tree/pieces.js';
import { oneLine } from './textFold.js';

/**
 * Wavefront OBJ export of the rocket's EXTERNAL 3D geometry — the 3D view's
 * own meshes (lathe nose profiles, tubes, transitions, extruded fins at their
 * instance angles), less the inner tubes the view draws through its
 * translucent shell (isShellPiece). Units are METERS; scale on import (most
 * slicers ask). Meant for print-preview/display models and CAD reference — it
 * is surface geometry, not a guaranteed-watertight solid.
 */
export function rocketToObj(tree: RocketTree, name: string): string {
  const built = buildPieces(tree);
  const pieces = built.pieces.filter(isShellPiece);
  const { totalLen } = built;
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
    // oneLine: a name from an imported file or a share link can carry a raw
    // line break, and everything after it would become a live `v`/`f` record
    // (audit 2026-09-22) — three's absolute face indices then point at the
    // wrong vertices. The name stays UTF-8: this is a comment, not a field.
    `# MMRocket Sim — ${oneLine(name)}`,
    '# Units: METERS (rocket axis = +X, nose tip at x=0)',
    `# Overall length: ${(totalLen * 1000).toFixed(1)} mm`,
    obj,
  ].join('\n');
}
