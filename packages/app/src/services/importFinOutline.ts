import type { ComponentNode } from '@online-openrocket/engine';
import type { UnitSelection } from '../prefs/units.js';
import { finOutlineProblem } from '../tree/finOutline.js';
import { KERNEL_DEFAULT_FIN_POINTS } from '../tree/kernelDefaults.js';
import { cautionNote } from './importNotes.js';

/** Synthesized outlines need the same check as explicit freeform points. */
export function repairImportedFinOutline(node: ComponentNode, notes: string[], units: UnitSelection): string | null {
  const problem = finOutlineProblem(node['points'] as [number, number][], units);
  if (problem) {
    node['points'] = KERNEL_DEFAULT_FIN_POINTS.map(([x, y]) => [x, y]);
    cautionNote(notes, 'I05.fin-outline', `Fin set "${node.name ?? 'freeform'}": its outline was not used — ${problem} The set keeps a default outline; redraw it in the fin editor.`);
  }
  return problem;
}
