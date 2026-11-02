// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { importOrk, autoDelaySaveNote } from './orkFile.js';
import { importRkt, exportRkt } from './rocksimFile.js';
import { OVERRIDE_INCLUDES_MOTOR, reconcileIncludedMotor } from './statedLaunchWeight.js';
import { noteField } from './noteField.js';
import { tubeWrapGeometry } from './tubeWrapGuide.js';
import { incompleteFlightWarning } from './simReport.js';
import { autoAlignFinSets } from '../tree/finAlign.js';
import { refusedExMotorNote } from './exMotors.js';
import { solveAutoDelays, delayMountsOf } from './autoDelaySolver.js';
import { testMotor, probeFlight } from './autoDelay.testSupport.js';
import { replacementLossNote } from './lossySave.js';
import { fileLongitudeNote } from './longitudeCheck.js';
import { createWarningMergeBudget, warningMergeNotes } from './storedRunIdentity.js';

const hostile = 'FILE\n\r\u2028\u2029\u202e\u200b”END🚀';
const safe = (notes: string[]) => {
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.join(' ')).toContain('[U+200B]');
  for (const note of notes) expect(note).not.toMatch(/[\r\n\u2028\u2029\u202e\u200b]/u);
};
const fixture = (name: string) => readFileSync(new NodeURL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

describe('file spans in sibling note producers', () => {
  it('cleans the simulation name in longitude evidence', () => {
    const note = fileLongitudeNote({ opened: { latitudeDeg: 26, longitudeDeg: 80 },
      sibling: { latitudeDeg: 26, longitudeDeg: -80 }, siblingCount: 1,
      distanceKm: 13000, flippedDistanceKm: 0 }, hostile);
    safe([note]);
    expect(note).toContain(`“${noteField(hostile)}”`);
  });
  it('cleans a stored run id without changing its merge identity', () => {
    const work = createWarningMergeBudget();
    work.skippedCopies.set(hostile, 2);
    const notes = warningMergeNotes(work);
    safe(notes);
    expect(notes[0]).toContain(`“${noteField(hostile)}”`);
    expect(work.skippedCopies.get(hostile)).toBe(2);
  });
  it('cleans the parent name in reconstructed cluster notes', () => {
    const tubes = [0, Math.PI].map(angle => `<BodyTube><Name>Tube</Name>
      <IsInsideTube>1</IsInsideTube><Len>100</Len><OD>24</OD><ID>22</ID>
      <RadialLoc>12</RadialLoc><RadialAngle>${angle}</RadialAngle></BodyTube>`).join('');
    const result = importRkt(`<RockSimDocument><DesignInformation><RocketDesign>
      <Name>Test</Name><StageCount>1</StageCount><Stage3Parts><BodyTube>
      <Name>${hostile}</Name><Len>500</Len><OD>100</OD><ID>98</ID>
      <AttachedParts>${tubes}</AttachedParts></BodyTube></Stage3Parts>
      </RocketDesign></DesignInformation></RockSimDocument>`);
    const notes = result.notes.filter(note => note.startsWith('Cluster:'));
    safe(notes);
    expect(notes[0]).toContain('[U+201D]');
  });
  it('bounds saved EX note line counts and aggregate characters', () => {
    const open = (lines: string[]) => importOrk(fixture('auto-radius-15.03.ork')
      .replace('</rocket>', `<mmrexmotornotes>${lines.join('\n')}</mmrexmotornotes></rocket>`)).notes;
    const many = open(Array.from({ length: 200000 }, (_, i) => `Entry ${i}`));
    expect(many.filter(line => line.startsWith('Entry '))).toHaveLength(64);
    expect(many).toContain('…199936 more notes not shown');
    const large = open(['x'.repeat(65536), 'overflow']);
    expect(large).toContain('x'.repeat(65536));
    expect(large).not.toContain('overflow');
    expect(large).toContain('…1 more notes not shown');
  });
  it('keeps saved EX note list boundaries on reopening', () => {
    const xml = fixture('auto-radius-15.03.ork').replace('</rocket>', '<mmrexmotornotes>First\nSecond\u200b”</mmrexmotornotes></rocket>');
    const notes = importOrk(xml).notes;
    expect(notes).toContain('First');
    expect(notes).toContain('Second[U+200B][U+201D]');
  });
  it('cleans the filename in a replacement loss notice', () => {
    const text = replacementLossNote({ name: hostile, format: 'rkt', via: 'opened' },
      { format: 'rkt', losses: ['one part'], refused: null });
    safe([text!]);
  });
  it('cleans the mount name in an Auto-delay solver refusal', async () => {
    const mounts = delayMountsOf([['a', testMotor()]], { a: hostile });
    await expect(solveAutoDelays({ mounts, probe: () => ({ ...probeFlight(), delayProbe: undefined }),
      budget: { probes: 0 } })).rejects.toThrow(`Auto delay did not settle for ${noteField(hostile)}:`);
  });
  it('cleans a stage name in an incomplete-flight warning', () => {
    safe([incompleteFlightWarning(hostile, 5, true).message]);
  });
  it('cleans aligned fin names without changing the design names', () => {
    const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.049, children:
      ['one', 'two'].map(id => ({ type: 'trapezoidfinset' as const, id, name: hostile, finCount: 3, rootChord: 0.06, height: 0.04,
        position: { method: 'bottom' as const, offset: 0 } })) }] }] };
    const result = autoAlignFinSets(tree);
    safe(result.changes);
    expect(result.tree.components[0]!.children![0]!.children![0]!.name).toBe(hostile);
  });
  it('cleans a refused library motor designation', () => {
    safe([refusedExMotorNote(hostile)]);
  });
  it('cleans fin names in a marking guide caution', () => {
    const tube: ComponentNode = { type: 'bodytube', id: 'tube', length: 1, outerRadius: 0.03, children: [
      { type: 'trapezoidfinset', name: hostile, rootChord: 0.1, tipChord: 0.05, height: 0.03, cant: 0.1 },
    ] };
    safe(tubeWrapGeometry({ components: [{ type: 'stage', children: [tube] }] }, tube).notes);
  });
  it('keeps ORK inferred-part names inside their note', () => {
    const xml = fixture('auto-radius-15.03.ork').replace(/(<name>)[^<]*/g, `$1${hostile}`);
    safe(importOrk(xml).notes);
  });
  it('keeps RockSim simulation and part names inside their notes', () => {
    const xml = fixture('first-sim-unloadable.rkt').replace(/(<(?:Name|SimulationName)>)[^<]*/g, `$1${hostile}`);
    safe(importRkt(xml).notes);
  });
  it('keeps save-loss part names inside their notes without changing saved names', () => {
    const tree: RocketTree = { components: [{ type: 'stage', name: hostile, overrideMass: 1, overrideSubcomponentsMass: true, children: [
      { type: 'bodytube', name: hostile, length: 0.5, outerRadius: 0.03, thickness: 0.001, children: [
        { type: 'transition', name: hostile, length: 0.1, foreRadius: 0.03, aftRadius: 0.02, foreShoulderLength: 0.01, foreShoulderThickness: 0.004 },
      ] },
    ] }] };
    const notes: string[] = [];
    const xml = exportRkt({ name: 'Safety', tree, notes });
    safe(notes);
    expect(xml).toContain('END🚀');
    expect(tree.components[0]!.name).toBe(hostile);
  });
  it('cleans both motor identities and the stage in launch-weight reconciliation', () => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', name: hostile,
      [OVERRIDE_INCLUDES_MOTOR]: hostile, overrideMass: 1, overrideSubcomponentsMass: true, children: [
        { type: 'bodytube', id: 'mount', motorMount: true, length: 1 },
      ] }] };
    const result = reconcileIncludedMotor(tree, 'mount', { designation: 'OTHER' + hostile, launchMassKg: 0.1, lengthM: 0.1, cgXFromFrontM: 0.05 },
      { mass: n => `${n} kg`, length: n => `${n} m` });
    safe([result!.note!]);
    expect(result!.note).toContain(noteField('OTHER' + hostile));
  });
  it('cleans the motor designation in an Auto-delay save note', () => {
    const note = autoDelaySaveNote({ designation: hostile, diameter: 0.018, length: 0.07, delay: 5, autoDelay: true, autoDelayFrom: 'provisional' }, '.ork');
    safe([note!]);
  });
});
