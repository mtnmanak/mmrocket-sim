// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { archiveExMotors } from './exMotorArchive.js';
import { addExMotors, exToMotorSpec, parseEng } from './exMotors.js';
import { exportOrk } from './orkFile.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it.each(['live', 'copied aside'])('Save names the missing legacy maker when refused EX data is %s', state => {
  const motor = parseEng('Legacy 29 100 P 0.05 0.1 OriginalMaker\n0 0\n0.5 20\n1 0')[0]!;
  const refused = { ...motor, totalWeightG: 'bad' };
  const key = 'online-openrocket.ex-motors.v1';
  localStorage.setItem(state === 'live' ? key : `${key}.unreadable-backup`, JSON.stringify([refused]));
  const notes: string[] = [];
  const spec = exToMotorSpec(motor, Infinity);
  delete spec.exDefinition; // A session saved before source definitions were captured.
  const ref = { exMotorId: motor.motorId, designation: 'Legacy\n\u202e', diameter: 0.029,
    length: 0.1, delay: Infinity, exMotorSpec: spec };
  archiveExMotors([ref], notes);
  expect(notes.join(' ')).toContain('no maker is available');
  expect(notes.join(' ')).toContain('desktop OR');
  expect(notes.join(' ')).not.toMatch(/[\n\u202e]/);
  const tree = defaultTree(), saveNotes: string[] = [];
  exportOrk({ name: 'Legacy', tree, motors: { [motorMounts(tree)[0]!.id!]: ref }, notes: saveNotes });
  expect(saveNotes.join(' ')).toContain('no maker is available');
});

it('reports copying refused EX rows aside in the library write result', () => {
  const motor = parseEng('New 29 100 P 0.05 0.1 Maker\n0 0\n0.5 20\n1 0')[0]!;
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([{ ...motor, motorId: 'ex:legacy', totalWeightG: 'bad' }]));
  expect(addExMotors([motor])).toMatchObject({ stored: true, backedUp: true });
});
