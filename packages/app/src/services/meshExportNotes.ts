import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { INITIAL_UNITS, noticeComparison, type UnitSelection } from '../prefs/units.js';
import { noteField } from './noteField.js';
import { drawnRadius } from '../tree/schematicLayout.js';
import { resolveTransitionRadii } from '../tree/transitionRadii.js';
import { isConformal, shroudHalfWidth } from '../tree/shroud.js';
import { kernelNum } from '../tree/kernelDefaults.js';
import { MAX_FIN_OUTLINE_POINTS } from '../tree/finOutline.js';

/** The width actually drawn/exported; the specified aerodynamic envelope stays unchanged. */
export function shroudWidthNotice(node: ComponentNode, bodyRadius: number, units: UnitSelection = INITIAL_UNITS): string | null {
  if (!(kernelNum(node, 'length') > 0) || !(kernelNum(node, 'height') > 0)) return null;
  const width = kernelNum(node, 'width');
  const effective = 2 * shroudHalfWidth(bodyRadius, width, isConformal(node));
  if (!(width > effective + 1e-12)) return null;
  const [actual, specified] = noticeComparison('length', effective, width, units);
  return `“${noteField(node.name || 'Camera shroud')}”: the view and mesh exports use a width of ${actual} `
    + `instead of the specified ${specified} to seat the shroud on this tube. `
    + 'Aerodynamics still use the specified width. Check the exported dimensions before fabrication.';
}

/** The panel and mesh-save notices share this disclosure of retained large fins. */
export function finMeshOmissionNotice(node: ComponentNode): string | null {
  if (node.type !== 'freeformfinset' || !Array.isArray(node['points']) || node['points'].length <= MAX_FIN_OUTLINE_POINTS) return null;
  return `“${noteField(node.name || 'Freeform fins')}”: this outline exceeds the 5,000-point validation limit. `
    + 'The fins are omitted from the 3D view and whole-rocket mesh exports but are still included in simulation. '
    + 'Simplify a copy before editing or fabrication; these meshes do not represent the complete rocket.';
}

/** Shared disclosures for whole-rocket STL, OBJ and GLB exports, including pod children. */
export function meshExportNotes(tree: RocketTree, units: UnitSelection = INITIAL_UNITS): string[] {
  const notes: string[] = [];
  const visit = (nodes: ComponentNode[], parent?: ComponentNode) => {
    for (const node of nodes) {
      const omitted = finMeshOmissionNotice(node);
      if (omitted) notes.push(omitted);
      if (node.type === 'fairing' && parent) {
        const note = shroudWidthNotice(node, drawnRadius(parent), units);
        if (note) notes.push(note);
      }
      visit(node.children ?? [], node);
    }
  };
  visit(resolveTransitionRadii(tree).components);
  return notes;
}
