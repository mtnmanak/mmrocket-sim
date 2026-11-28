import { noteField } from './noteField.js';
import type { RocketTree } from '@online-openrocket/engine';
import { asStageNodes, nameOr, nozzleStages } from '../tree/treeModel.js';

/** Unsupported formats must not silently lose a typed exit or durable OFF. */
export function nozzleExportNotes(tree: RocketTree, format: '.rkt' | '.CDX1', exportedEngines: readonly (string | null)[] = []): string[] {
  const stages = asStageNodes(tree);
  return nozzleStages(tree).flatMap((s) => {
    const d = s['nozzleExitDiameter'];
    const name = noteField(nameOr(s, s.type === 'parallelstage' ? 'Strap-on' : 'Stage'));
    if (d == null && format === '.CDX1' && s.type !== 'parallelstage') {
      const index = stages.indexOf(s);
      // The writer puts 0 in both booster slots when the stage has no exported
      // engine, and a readable stated 0 reopens as OFF (ruling D2).
      if (index > 0 && !exportedEngines[index]) return [`${name}: .CDX1 writes 0 (OFF) for this stage because it has no exported engine, so any automatic exit is lost and the stage reopens with nozzle effects off. Keep an .ork copy.`];
      return [`${name}: .CDX1 writes the flown automatic exit, or 0 (OFF) when none is flown; automatic motor-following is lost on reopen. Keep an .ork copy.`];
    }
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return [];
    if (format === '.CDX1' && s.type !== 'parallelstage') return [];
    return [`${name}: ${format} cannot preserve `
      + `${d === 0 ? 'the explicit nozzle OFF setting' : 'this nozzle exit diameter'}. `
      + 'Keep an .ork copy. Reopening flies the published exit for the loaded motor when the field is blank.'];
  });
}
