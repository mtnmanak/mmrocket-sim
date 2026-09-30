import type { RocketTree } from '@online-openrocket/engine';
import { nozzleStages } from '../tree/treeModel.js';

/** Unsupported formats must not silently lose a typed exit or durable OFF. */
export function nozzleExportNotes(tree: RocketTree, format: '.rkt' | '.CDX1'): string[] {
  return nozzleStages(tree).flatMap((s) => {
    const d = s['nozzleExitDiameter'];
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return [];
    if (format === '.CDX1' && s.type !== 'parallelstage' && d > 0) return [];
    return [`${s.name ?? (s.type === 'parallelstage' ? 'Strap-on' : 'Stage')}: ${format} cannot preserve `
      + `${d === 0 ? 'the explicit nozzle OFF setting' : 'this nozzle exit diameter'}. `
      + 'Keep an .ork copy. Reopening may automatically fill a published exit for the loaded motor.'];
  });
}
