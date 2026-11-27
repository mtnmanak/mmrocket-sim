// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
import { motorFitWarnings } from './motorFitWarnings.js';
import { formatWarning, formatWarningText } from './simWarnings.js';
import { noteField } from './noteField.js';
import { motorMounts } from '../tree/treeModel.js';
import { planConfigSwitch } from './importApply.js';
import { applyOpenMotorChoices } from './openMotorChoices.js';
import { parseEng } from './exMotors.js';

it.each(['[MMT 1]', '\u201cMMT\u201d', '\u202eMMT'])('r7 preserves mount %s through both warning formatters', name => {
  const tree = balanceTree(1), motor = balanceMotor();
  motorMounts(tree)[0]!.name = name;
  motor.spec.length = 2;
  motor.spec.diameter = 0.1;
  const warnings = [...motorFitWarnings(tree, [['m0', motor]]),
    ...asymmetricThrustWarnings(tree, [['m0', motor]]).filter(w => w.key === 'ASYMMETRIC_THRUST_LONE')];
  expect(warnings.map(w => w.key)).toEqual(['MOTOR_TOO_LONG', 'MOTOR_TOO_WIDE', 'ASYMMETRIC_THRUST_LONE']);
  for (const warning of warnings) {
    expect(formatWarning(warning).detail).toContain(`\u201c${noteField(name)}\u201d`);
    expect(formatWarningText(warning.message)).toContain(`\u201c${noteField(name)}\u201d`);
  }
});

it('r7 calls only estimated motor room an estimate', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  motor.spec.length = 2;
  expect(motorFitWarnings(tree, [['m0', motor]])[0]!.message).toContain('room is an estimate');
  motorMounts(tree)[0]!['maxMotorLength'] = 0.2;
  const explicit = motorFitWarnings(tree, [['m0', motor]])[0]!.message;
  expect(explicit).toContain('Max motor length');
  expect(explicit).not.toContain('estimate');
  expect(explicit).toContain('does not model this collision');
});

it('r7 config switches preserve file choices and refresh fit cautions in both directions', () => {
  const tree = balanceTree(1), wide = balanceMotor(), fits = balanceMotor();
  wide.meta.motorId = 'wide'; wide.spec.diameter = 0.1;
  fits.meta.motorId = 'fits';
  const mount = motorMounts(tree)[0]!;
  mount['fileMotorIds'] = ['obsolete'];
  const a = { id: 'a', name: 'Wide', isDefault: true, motors: { m0: wide } };
  const b = { id: 'b', name: 'Fits', isDefault: false, motors: { m0: fits } };
  const state = { tree, savedConfigs: [a, b], mountMotors: a.motors, unmatchedRefs: {}, activeConfigId: 'a' };
  const next = planConfigSwitch(state, b, { mass: String, length: String });
  expect(motorMounts(next.tree)[0]!['fileMotorIds']).toEqual(['obsolete']);
  expect(next.note.group.lines.filter(n => n.kind === 'I12.motor-fit')).toEqual([]);
  const back = planConfigSwitch({ ...state, ...next }, a, { mass: String, length: String });
  expect(back.note.group.lines.filter(n => n.kind === 'I12.motor-fit')).toHaveLength(1);
  expect(back.note.severity).toBe('warn');
  expect(mount['fileMotorIds']).toEqual(['obsolete']);
});

it.each(['motorId', 'exMotorId'] as const)('J23-L2 config switches never give a working %s motor file provenance', key => {
  const tree = balanceTree(1), wide = balanceMotor();
  wide.meta[key] = 'link-wide'; wide.spec.diameter = 0.1;
  const a = { id: 'a', name: 'Working', isDefault: true, motors: {} };
  const b = { id: 'b', name: 'Other', isDefault: false, motors: {} };
  const next = planConfigSwitch({ tree, savedConfigs: [a, b], mountMotors: { m0: wide },
    unmatchedRefs: {}, activeConfigId: 'a' }, b, { mass: String, length: String });
  expect(motorMounts(next.tree)[0]!['fileMotorIds']).toBeUndefined();
});

it.each(['wide', 'fits', 'empty'] as const)('r7 open motor choice %s refreshes its file choices and fit notes', async kind => {
  const tree = balanceTree(1), old = balanceMotor();
  old.meta.motorId = 'old-wide'; old.spec.diameter = 0.1;
  motorMounts(tree)[0]!['fileMotorIds'] = ['old-wide'];
  const ex = parseEng(`E20 ${kind === 'wide' ? 100 : 29} 100 5 0.02 0.05 Acme\n0 0\n0.1 20\n1 0`)[0]!;
  const ref = { manufacturer: 'Acme', designation: 'E20', diameter: 0.1, length: 0.1, delay: 5 };
  const group = { key: 'g', ref, candidates: [], carriedBy: [], locations: [{ configId: 'a', mountId: 'm0', ref }] };
  const next = await applyOpenMotorChoices({ tree, mountMotors: { m0: old }, savedConfigs: [
    { id: 'a', name: 'Chosen', isDefault: true, motors: { m0: old } },
  ], unmatchedRefs: {} }, 'a', [group], { g: kind === 'empty' ? { kind: 'empty' } : { kind: 'ex', motor: ex } });
  expect(motorMounts(next.tree)[0]!['fileMotorIds']).toEqual(kind === 'wide' ? [ex.motorId] : []);
  expect(next.fitNotes.filter(n => n.kind === 'I12.motor-fit')).toHaveLength(kind === 'wide' ? 1 : 0);
  expect(motorMounts(tree)[0]!['fileMotorIds']).toEqual(['old-wide']);
});
