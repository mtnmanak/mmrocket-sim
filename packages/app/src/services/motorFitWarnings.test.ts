// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { motorFitWarnings } from './motorFitWarnings.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { IMPERIAL_UNITS, INITIAL_UNITS } from '../prefs/units.js';
import { preflightAudit } from './preflightAudit.js';
import { staticWarningTier, warningTier } from './simWarnings.js';
import { applyImportPlan, planImport } from './importApply.js';
import { addExMotors, parseEng } from './exMotors.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { cloneSubtree, defaultTree, motorMounts, updateNode } from '../tree/treeModel.js';
import { scaleRocket } from '../tree/scaleRocket.js';
import { recoverAssumedBores } from './assumedBore.js';
import { simulateDesign } from './simulateDesign.js';
import { commentsOf } from './simReport.js';
import { designStateFromSession } from './sessionRestore.js';
import { importCdx1 } from './rasaeroFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt, importRkt } from './rocksimFile.js';

it('r5 a modern provenance marker prevents migration of a measured 2 mm sibling', () => {
  const tree = balanceTree(2);
  const [first, second] = motorMounts(tree);
  first!['boreAssumed'] = true;
  second!.type = 'bodytube';
  second!['thickness'] = 0.002;
  expect(motorMounts(recoverAssumedBores(tree, true))[1]!['boreAssumed']).toBeUndefined();
});

it('r5 file-motor exceptions belong only to the original unscaled mount', () => {
  const tree = balanceTree(1), mount = motorMounts(tree)[0]!;
  mount['fileMotorIds'] = ['wide'];
  expect(cloneSubtree(mount)['fileMotorIds']).toEqual([]);
  expect(motorMounts(scaleRocket(tree, 0.5).tree)[0]!['fileMotorIds']).toEqual([]);
  expect(mount['fileMotorIds']).toEqual(['wide']);
});

it('r5 restoring a scaled mount does not recover its discarded file exception', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  motor.meta.motorId = 'scaled-wide'; motor.spec.diameter = 0.1;
  motorMounts(tree)[0]!['fileMotorIds'] = ['scaled-wide'];
  const scaled = scaleRocket(tree, 0.5).tree;
  const restored = designStateFromSession({ tree: scaled, savedAt: 1, launch: DEFAULT_CONDITIONS,
    mountMotors: { m0: motor } }, { legacyMaxMotorLengthM: null });
  expect(motorMounts(restored.state.tree)[0]!['fileMotorIds']).toEqual([]);
});

it('r5 fitting imported motors need no browser exception', () => {
  const motor = balanceMotor(); motor.meta.motorId = 'fitting';
  const plan = planImport({ name: 'Fits', tree: balanceTree(1), motors: { m0: {
    manufacturer: 'Test', designation: 'Fits', diameter: motor.spec.diameter, length: motor.spec.length, delay: 5,
  } }, notes: [] },
    { working: { m0: { motor, note: '' } }, configs: {} },
    { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
  expect(plan.snapshot.mountMotors.m0?.meta.motorId).toBe('fitting');
  expect(motorMounts(plan.snapshot.tree)[0]!['fileMotorIds']).toBeUndefined();
});

it('r4 opening an unmarked RASAero ORK recovers only the assumed wall', () => {
  const imported = importCdx1('<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>1.6</Diameter></BodyTube></RocketDesign><SimulationList><Simulation><SustainerEngine>I280DM  (AT)</SustainerEngine></Simulation></SimulationList></RASAeroDocument>');
  const motor = balanceMotor();
  motor.spec.diameter = 0.038;
  const xml = exportOrk({ name: imported.name, tree: imported.tree,
    configs: [{ id: 'rasaero-sim-1', name: 'Imported', isDefault: true, motors: {} }] });
  const legacy = xml.replace(/<mmrsim-bore-assumed>true<\/mmrsim-bore-assumed>/g, '');
  for (const [source, expected] of [[legacy, true], [xml.replaceAll('>true</mmrsim-bore-assumed>', '>false</mmrsim-bore-assumed>'), false],
    [legacy.replaceAll('rasaero-sim-1', 'native'), undefined]] as const) {
    const opened = importOrk(source), mount = motorMounts(opened.tree)[0]!;
    expect(mount['boreAssumed']).toBe(expected);
    opened.motors = { [mount.id!]: { manufacturer: 'Test', designation: 'Motor', diameter: 0.038, length: 0.1, delay: 5 } };
    const plan = planImport(opened, { working: { [mount.id!]: { motor, note: '' } }, configs: {} },
      { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
    expect(motorFitWarnings(plan.snapshot.tree, [[mount.id!, motor]]).some(w => w.key === 'MOTOR_TOO_WIDE')).toBe(expected !== true);
    expect(plan.note.text.includes('real rocket could not be built this way')).toBe(expected !== true);
  }
});

it.each([true, false])('r4 RockSim round trips assumed-bore provenance %s', assumed => {
  const imported = importCdx1('<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>1.6</Diameter></BodyTube></RocketDesign><SimulationList><Simulation><SustainerEngine>I280DM  (AT)</SustainerEngine></Simulation></SimulationList></RASAeroDocument>');
  const mount = motorMounts(imported.tree)[0]!;
  mount['boreAssumed'] = assumed;
  const reopened = importRkt(exportRkt({ name: imported.name, tree: imported.tree }));
  const motor = balanceMotor();
  motor.spec.diameter = 0.038;
  const restoredMount = motorMounts(reopened.tree)[0]!;
  expect(restoredMount['boreAssumed']).toBe(assumed);
  expect(motorFitWarnings(reopened.tree, [[restoredMount.id!, motor]]).some(w => w.key === 'MOTOR_TOO_WIDE')).toBe(!assumed);
});

it('r3 restores the assumed bore of a base-revision RASAero autosave', async () => {
  const imported = importCdx1('<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>1.6</Diameter></BodyTube></RocketDesign><SimulationList><Simulation><SustainerEngine>I280DM  (AT)</SustainerEngine></Simulation></SimulationList></RASAeroDocument>');
  const mount = motorMounts(imported.tree)[0]!, motor = balanceMotor();
  motor.spec.diameter = 0.038;
  delete mount['boreAssumed']; // The released importer invented the wall without marking it.
  const restore = (tree = imported.tree) => designStateFromSession({ tree, savedAt: 1, launch: DEFAULT_CONDITIONS,
    appVersion: '0.211', designFile: { name: 'old.CDX1', via: 'opened', format: 'cdx1' },
    mountMotors: { [mount.id!]: motor } }, { legacyMaxMotorLengthM: null });
  const restored = restore();
  expect(motorFitWarnings(restored.state.tree, Object.entries(restored.state.mountMotors)).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  expect(motorMounts(restored.state.tree)[0]!['boreAssumed']).toBe(true);
  // Saving as ORK can replace designFile; the retained RASAero configs still
  // identify the old imported tubes when that session is restored.
  const viaOrk = designStateFromSession({ tree: imported.tree, savedAt: 1, launch: DEFAULT_CONDITIONS,
    designFile: { name: 'old.ork', via: 'saved', format: 'ork' },
    mountMotors: { [mount.id!]: motor }, savedConfigs: [{ id: 'rasaero-sim-1', name: 'Imported',
      isDefault: true, motors: { [mount.id!]: motor } }] }, { legacyMaxMotorLengthM: null });
  expect(motorMounts(viaOrk.state.tree)[0]!['boreAssumed']).toBe(true);
  const measured = updateNode(restored.state.tree, mount.id!, { thickness: 0.002 });
  expect(motorFitWarnings(restore(measured).state.tree, [[mount.id!, motor]]).map(w => w.key)).toContain('MOTOR_TOO_WIDE');
  const { exportOrk, importOrk } = await import('./orkFile.js');
  const reopened = importOrk(exportOrk({ name: imported.name, tree: measured }));
  expect(motorMounts(reopened.tree)[0]!['boreAssumed']).toBe(false);
  expect(mount['boreAssumed']).toBeUndefined();
});

it('r2 restores original motor choices from older working sets and configurations', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  motor.meta.motorId = 'old-wide';
  motor.spec.diameter = 0.1;
  const other = structuredClone(motor);
  other.meta.motorId = 'config-wide';
  const restored = designStateFromSession({ tree, savedAt: 1, launch: DEFAULT_CONDITIONS,
    mountMotors: { m0: motor }, savedConfigs: [{ id: 'cfg', name: 'Other', isDefault: false, motors: { m0: other } }] },
  { legacyMaxMotorLengthM: null });
  expect(motorMounts(restored.state.tree)[0]!['fileMotorIds']).toEqual(['old-wide', 'config-wide']);
  expect(motorMounts(tree)[0]!['fileMotorIds']).toBeUndefined();
  const fitting = balanceMotor();
  const pristine = designStateFromSession({ tree, savedAt: 1, launch: DEFAULT_CONDITIONS, mountMotors: { m0: fitting } },
    { legacyMaxMotorLengthM: null });
  expect(motorMounts(pristine.state.tree)[0]!['fileMotorIds']).toBeUndefined();
});

it('r2 skips width cautions only for an importer-assumed bore, including save and reopen', async () => {
  const imported = importCdx1('<RASAeroDocument><RocketDesign><NoseCone><Length>6</Length><Diameter>1.6</Diameter></NoseCone><BodyTube><Length>20</Length><Diameter>1.6</Diameter></BodyTube></RocketDesign><SimulationList><Simulation><SustainerEngine>I280DM  (AT)</SustainerEngine></Simulation></SimulationList></RASAeroDocument>');
  const mount = motorMounts(imported.tree)[0]!, motor = balanceMotor();
  motor.spec.diameter = 0.038;
  expect(motorFitWarnings(imported.tree, [[mount.id!, motor]]).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  const { exportOrk, importOrk } = await import('./orkFile.js');
  const reopened = importOrk(exportOrk({ name: imported.name, tree: imported.tree }));
  expect(motorFitWarnings(reopened.tree, [[motorMounts(reopened.tree)[0]!.id!, motor]]).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  const renamed = updateNode(imported.tree, mount.id!, { name: 'Renamed' });
  expect(motorFitWarnings(renamed, [[mount.id!, motor]]).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  const unstatedWall = updateNode(imported.tree, mount.id!, { thickness: undefined });
  expect(motorFitWarnings(unstatedWall, [[mount.id!, motor]]).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  const measured = updateNode(imported.tree, mount.id!, { thickness: 0.002 });
  expect(motorFitWarnings(measured, [[mount.id!, motor]]).map(w => w.key)).toContain('MOTOR_TOO_WIDE');
  const solid = updateNode(imported.tree, mount.id!, { filled: true });
  expect(motorFitWarnings(solid, [[mount.id!, motor]]).map(w => w.key)).toContain('MOTOR_TOO_WIDE');
  const hollowAgain = updateNode(solid, mount.id!, { filled: false });
  expect(motorFitWarnings(hollowAgain, [[mount.id!, motor]]).map(w => w.key)).not.toContain('MOTOR_TOO_WIDE');
  motor.spec.diameter = 0.06;
  const caseAirframe = updateNode(imported.tree, mount.id!, { caseAirframe: true });
  expect(motorFitWarnings(caseAirframe, [[mount.id!, motor]]).map(w => w.key)).toContain('MOTOR_TOO_WIDE');
  const real = balanceTree(1);
  motorMounts(real)[0]!['outerRadius'] = 0.018;
  expect(motorFitWarnings(real, [['m0', motor]]).map(w => w.key)).toContain('MOTOR_TOO_WIDE');
});

it('r2 leaves incomplete recovered motor validation to the existing refusal path', () => {
  const incomplete = { ...balanceMotor(), spec: undefined } as unknown as ReturnType<typeof balanceMotor>;
  const restored = designStateFromSession({ tree: balanceTree(1), savedAt: 1, launch: DEFAULT_CONDITIONS,
    mountMotors: { m0: incomplete } }, { legacyMaxMotorLengthM: null });
  expect(restored.state.mountMotors['m0']?.spec).toBeUndefined();
  expect(motorMounts(restored.state.tree)[0]!['fileMotorIds']).toBeUndefined();
});

afterEach(() => localStorage.clear());

it.each([null, 0.05])('J23 warns at Caution for motor length with limit %s, using preferred units', limit => {
  const tree = balanceTree(1);
  const mount = motorMounts(tree)[0]!;
  if (limit !== null) mount['maxMotorLength'] = limit;
  const motor = balanceMotor();
  motor.label = 'Motor\n\u202e';
  motor.spec.length = 2;
  motor.spec.diameter = 0.1;
  for (const units of [INITIAL_UNITS, IMPERIAL_UNITS]) {
    const warnings = motorFitWarnings(tree, [['m0', motor]], units);
    expect(warnings.map(w => w.key)).toEqual(['MOTOR_TOO_LONG', 'MOTOR_TOO_WIDE']);
    expect(warnings.every(w => warningTier(w.key) === 'caution')).toBe(true);
    expect(warnings[0]!.message).toContain(limit === null ? 'estimated room' : 'Max motor length');
    expect(warnings[0]!.message.includes('is an estimate')).toBe(limit === null);
    expect(warnings[0]!.message).toContain(units.motorDimensions);
    expect(warnings[1]!.message).toMatch(/real rocket could not be built this way/i);
    expect(warnings[1]!.message).not.toMatch(/[\n\u202e]/u);
    const notes = warnings.map(w => `[Warning.${w.key}] ${w.message}`);
    expect(notes.map(staticWarningTier)).toEqual(['caution', 'caution']);
    expect(preflightAudit(tree, {}, notes, units).findings.filter(f => f.kind === 'motor-fit'))
      .toEqual(warnings.map(w => expect.objectContaining({ tier: 'caution', reason: w.message })));
  }
});

it('J23 allows fitting motors and ignores a missing mount', () => {
  expect(motorFitWarnings(balanceTree(1), [['m0', balanceMotor()], ['missing', balanceMotor()]] )).toEqual([]);
});

it('J23 motor length tolerance absorbs residue but flags a real excess', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  motorMounts(tree)[0]!['maxMotorLength'] = motor.spec.length;
  expect(motorFitWarnings(tree, [['m0', motor]])).toEqual([]);
  motor.spec.length += 5e-10;
  expect(motorFitWarnings(tree, [['m0', motor]])).toEqual([]);
  motor.spec.length += 2e-9;
  expect(motorFitWarnings(tree, [['m0', motor]]).map(w => w.key)).toEqual(['MOTOR_TOO_LONG']);
});

it('J23 import cautions on width and retains the file motor on its mount without mutating the reader', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  motor.spec.diameter = 0.1;
  motor.meta.motorId = 'file-wide';
  const original = structuredClone(tree);
  const plan = planImport({ tree, name: 'Wide', motors: { m0: { manufacturer: 'Test', designation: 'Wide', diameter: 0.1, length: 0.1, delay: 5 } }, notes: [], sourceFormat: 'ork' },
    { working: { m0: { motor, note: '' } }, configs: {} },
    { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
  expect(plan.note.group.lines).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringMatching(/real rocket could not be built this way/i) }));
  expect(motorMounts(plan.snapshot.tree)[0]!['fileMotorIds']).toEqual(['file-wide']);
  expect(tree).toEqual(original);
});

it('J23 retains an embedded EX file motor after a library id collision', () => {
  const ex = parseEng('E20 29 100 5 0.02 0.05 Acme\n0 0\n0.1 20\n1 0')[0]!;
  addExMotors([{ ...ex, designation: 'Other motor' }]);
  const tree = balanceTree(1), motor = balanceMotor();
  motor.meta.exMotorId = ex.motorId;
  motor.spec.diameter = 0.1; // Only oversized file choices need an exception.
  const plan = planImport({ tree, name: 'EX', motors: { m0: { manufacturer: 'Acme', designation: 'E20', diameter: 0.029, length: 0.1, delay: 5 } }, notes: [], sourceFormat: 'ork' },
    { working: { m0: { motor, note: '' } }, configs: {} },
    { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
  expect(motorMounts(plan.snapshot.tree)[0]!['fileMotorIds']).toEqual([ex.motorId]);
  plan.embeddedExMotors = [ex];
  const noop = () => {};
  applyImportPlan(plan, { history: { reset: noop }, setMountMotors: noop, setUnmatchedRefs: noop,
    setSavedConfigs: noop, setActiveConfigId: noop, setLaunch: noop, setMeasured: noop, setMachAlt: noop,
    setNote: noop, setShroudPrompt: noop, markSaved: noop });
  const loaded = plan.snapshot.mountMotors['m0']!.meta.exMotorId;
  expect(loaded).not.toBe(ex.motorId);
  expect(motorMounts(plan.snapshot.tree)[0]!['fileMotorIds']).toEqual([loaded]);
});

it('r5 Launch stores each fit caution once for screen and print reports', async () => {
  const tree = defaultTree(), id = motorMounts(tree)[0]!.id!;
  const motor = balanceMotor(6, 1);
  motor.spec = { ...motor.spec, diameter: 0.018, length: 2, masses: [0.02, 0.019, 0.011, 0.01] };
  const out = await simulateDesign({ tree, mountMotors: { [id]: motor }, launch: DEFAULT_CONDITIONS,
    measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null, unmatchedRefs: {} },
  { aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false } });
  expect(out.run.simWarnings).toContainEqual(expect.objectContaining({ key: 'MOTOR_TOO_LONG' }));
  expect(commentsOf(out.run).filter(c => c.text.includes('Motor length'))).toEqual([]);
  expect(out.run.simWarnings?.filter(w => w.key === 'MOTOR_TOO_LONG')).toHaveLength(1);
  const { designPrintHtml } = await import('./designPrintReport.js');
  const html = designPrintHtml({ tree, info: out.build.info, units: INITIAL_UNITS, radiusMode: 'diameter',
    withMotors: true, appVersion: 'test', run: out.run, changedSince: null });
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent!;
  expect(text.split('Motor length 2000').length - 1).toBe(1);
}, 60_000);
