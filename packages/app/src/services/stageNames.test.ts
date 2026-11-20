import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { stagesWithNozzle } from '../tree/treeModel.js';
import { stageMotors } from './nozzleFollow.js';
import { nozzleExportNotes } from './nozzleExport.js';
import { nozzleOversizeText } from './nozzleCheck.js';
import { readFileSync } from 'node:fs';

it('J4 S7b-g2 S7b-g4 numbers axial stages separately and names blank strap-ons', () => {
  const tree: RocketTree = { components: [
    { type: 'stage', id: 's1', name: ' ', nozzleExitDiameter: 0.02, children: [
      { type: 'parallelstage', id: 'p', name: '', nozzleExitDiameter: 0.03 },
    ] }, { type: 'stage', id: 's2', name: '', nozzleExitDiameter: 0.04 },
  ] };
  expect(stagesWithNozzle(tree).map(s => s.name)).toEqual(['Stage 1', 'Strap-on', 'Stage 2']);
  expect(stageMotors(tree, []).map(s => s.stageName)).toEqual(['Stage 1', 'Strap-on', 'Stage 2']);
  expect(nozzleExportNotes(tree, '.rkt').join('\n')).toContain('Strap-on: .rkt');
  expect(nozzleExportNotes(tree, '.rkt').some(s => s.startsWith(':'))).toBe(false);
});

it('J4 S7b-g4 sanitizes stage names in nozzle oversize notices', () => {
  const text = nozzleOversizeText({ stageId: 's', stageName: 'Stage\n\u202eOne', exitDiameterM: 0.04, casingEquivalentM: 0.02, motorCount: 1 }, String);
  expect(text).not.toMatch(/[\n\u202e]/);
});

it('J4 r2 S7b-g4 wires the nozzle accessible name to the same blank-name fallback as its header', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  expect(app).toContain("const nozzleStageName = nameOr(nozzleStage, nozzleStage.type === 'parallelstage' ? 'Strap-on' : stName)");
  expect(app).toContain('stageName={nozzleStageName}');
});
