// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { defaultTree, engineTree, motorMounts, normalizeTree } from '../tree/treeModel.js';
import { addExMotors, deleteExMotor, exToDbEntry, getExMotor, loadExMotors, parseEng, parseRse, restoreExMotors, type ExMotor } from './exMotors.js';
import { archiveExMotors, MAX_EMBEDDED_EX_MOTORS, MAX_EX_ARCHIVE_BYTES, validArchivedExMotor } from './exMotorArchive.js';
import { MAX_EX_MOTOR_SAMPLES } from './exMotorLimits.js';
import { exportOrk, importOrk, type OrkExportMotor } from './orkFile.js';
import { matchImportedMotor, refToExportMotor } from './motorMatch.js';
import { toOrkMotor } from './orkExportMotors.js';
import { fetchMotorSpec } from './thrustcurve.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { autosaveToOrk } from './autosaveBackup.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { escapeXml } from './xmlUtil.js';
import { currentXmlParser, parseXml, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

const synthetic = (): ExMotor => ({
  motorId: 'ex:test-c6', designation: 'C6', realManufacturer: 'Test & Maker',
  diameter: 18, length: 70, delays: '3,5,P', totalWeightG: 24, propWeightG: 10,
  samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 12 }, { time: 0.5, thrust: 6 }, { time: 1.2, thrust: 0 }],
  sampleMassesKg: [0.024, 0.022, 0.018, 0.014], exitDiameterM: 0.005,
  source: 'rse', addedAt: 123,
});
const ref = (m = synthetic(), delay = 5): OrkExportMotor => ({
  exMotorId: m.motorId, designation: m.designation, manufacturer: m.realManufacturer,
  diameter: m.diameter / 1000, length: m.length / 1000, delay,
});
function saved(m = synthetic(), crossSection?: 'rounded' | 'airfoil') {
  addExMotors([m]);
  const tree = defaultTree();
  const freeform = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'trapezoidfinset' && crossSection) Object.assign(node, {
        type: 'freeformfinset', crossSection, points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]],
      });
      if (node.children) freeform(node.children);
    }
  };
  freeform(tree.components);
  const mount = motorMounts(tree)[0]!.id!;
  return { tree, mount, xml: exportOrk({ name: 'EX archive', tree, motors: { [mount]: ref(m) } }) };
}
const payload = (xml: string, data: unknown) => xml.replace(
  /<mmrexmotors version="1">[^]*?<\/mmrexmotors>/,
  `<mmrexmotors version="1">${escapeXml(JSON.stringify(data))}</mmrexmotors>`);
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('EX design archives', () => {
  it.each(['eng', 'rse'] as const)('clean-library %s save/open preserves every motor input and a real flight', async source => {
    const m = synthetic();
    if (source === 'eng') { m.source = 'eng'; delete m.sampleMassesKg; delete m.exitDiameterM; }
    const { tree, mount, xml } = saved(m, source === 'eng' ? 'rounded' : 'airfoil');
    const before = await fetchMotorSpec(exToDbEntry(m), 5);
    localStorage.clear();
    const opened = importOrk(xml);
    expect(loadExMotors()).toEqual([]);
    expect(opened.embeddedExMotors).toEqual([m]);
    const openedRef = Object.values(opened.motors)[0]!;
    const loaded = (await matchImportedMotor(openedRef)).motor!;
    expect(loaded.spec).toEqual(before);
    expect(loaded.meta.exMotorId).toBe(m.motorId);
    expect(loaded.meta.availableDelays).toEqual([3, 5, Infinity]);
    expect(toOrkMotor(loaded, undefined, loadExMotors).exMotorId).toBe(m.motorId);
    expect(refToExportMotor(openedRef).exMotorId).toBe(m.motorId);
    const fly = (t: RocketTree, id: string, spec: MotorSpec) => {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(normalizeTree(t)));
      rocket.setMotorById(id, spec);
      return rocket.simulate({ launchRodLength: 1, timeStep: 0.05, randomSeed: 1 }).summary;
    };
    const a = fly(tree, mount, before);
    const b = fly(opened.tree, openedRef.mountId!, loaded.spec);
    expect(a.maxAltitude).toBeGreaterThan(0);
    // Same kernel/process, tolerating geometry's six-significant-digit XML formatting.
    expect(b.maxAltitude).toBeCloseTo(a.maxAltitude, 4);
    expect(b.maxVelocity).toBeCloseTo(a.maxVelocity, 4);
  });

  it('keeps a different same-id/name curve, remaps mounts, and reuses identical data regardless of id/date/source/property order', async () => {
    const m = synthetic();
    const { xml } = saved(m);
    const twin = { ...m, samples: m.samples.map(s => ({ ...s, thrust: s.thrust * 2 })) };
    addExMotors([twin]);
    const opened = importOrk(xml);
    expect(loadExMotors()).toHaveLength(1);
    const ids = restoreExMotors(opened.embeddedExMotors!, opened.notes);
    expect(loadExMotors()).toHaveLength(2);
    expect(getExMotor(m.motorId)).toEqual(twin);
    const openedRef = Object.values(opened.motors)[0]!;
    expect(ids.get(openedRef.exMotorId!)).toBe(`${m.motorId}~2`);
    expect(openedRef.exMotorMissing).toBeUndefined();
    expect(Object.values(opened.configs[0]!.motors)[0]!.exMotorMissing).toBeUndefined();
    expect((await matchImportedMotor(openedRef)).motor!.spec.thrusts).toEqual(m.samples.map(s => s.thrust));
    expect(opened.notes.join(' ')).toContain('both were kept');
    importOrk(xml);
    expect(loadExMotors()).toHaveLength(2);
    localStorage.clear();
    const same = { ...m, motorId: 'ex:elsewhere', addedAt: 999, source: 'eng' as const,
      samples: m.samples.map(s => ({ thrust: s.thrust, time: s.time })) };
    addExMotors([same]);
    expect(restoreExMotors(importOrk(xml).embeddedExMotors!, []).get(m.motorId)).toBe(same.motorId);
    expect(loadExMotors()).toEqual([same]);
  });

  it('includes used motors once across configurations, omits unused library entries, and preserves plugged delays', async () => {
    const { tree, mount } = saved();
    const b = { ...synthetic(), motorId: 'ex:second', delays: 'P', designation: 'D12' };
    addExMotors([b, { ...b, motorId: 'ex:unused', designation: 'unused' }]);
    const xml = exportOrk({ name: 'configs', tree, configs: [
      { id: 'a', name: 'First', isDefault: true, motors: { [mount]: ref() } },
      { id: 'b', name: 'Second', isDefault: false, motors: { [mount]: ref(b, Infinity) } },
      { id: 'c', name: 'Repeat', isDefault: false, motors: { [mount]: ref() } },
    ] });
    expect(xml).not.toContain('ex:unused');
    localStorage.clear();
    const opened = importOrk(xml);
    expect(opened.embeddedExMotors).toHaveLength(2);
    expect(loadExMotors()).toEqual([]);
    const motor = (await matchImportedMotor(Object.values(opened.configs[1]!.motors)[0]!)).motor!;
    expect(motor.spec.ejectionDelay).toBe(Infinity);
    expect(motor.meta.exMotorId).toBe(b.motorId);
  });

  it('share links and the crash-recovery .ork carry the same complete curves', async () => {
    const { tree, mount, xml } = saved();
    const motor = (await matchImportedMotor(Object.values(importOrk(xml).motors)[0]!)).motor!;
    const recovery = autosaveToOrk({ tree, mountMotors: { [mount]: motor }, launch: DEFAULT_CONDITIONS, savedAt: 1 });
    const linked = await decodeShareFragment(await encodeShareFragment(xml));
    for (const file of [recovery, linked]) {
      localStorage.clear();
      const opened = importOrk(file);
      expect(opened.embeddedExMotors).toEqual([synthetic()]);
      expect(loadExMotors()).toEqual([]);
      expect((await matchImportedMotor(Object.values(opened.motors)[0]!)).motor!.spec).toEqual(motor.spec);
    }
  });

  it('places the plain-text extension under rocket, retaining native desktop references', () => {
    const { xml } = saved();
    const doc = parseXml(xml.replace(/^<\?xml[^?]*\?>/, ''), 'test XML');
    expect(doc.querySelectorAll('openrocket > rocket > mmrexmotors')).toHaveLength(1);
    expect(doc.querySelector('mmrexmotors')!.children).toHaveLength(0);
    expect(doc.querySelector('motor > manufacturer')!.textContent).toBe('Test & Maker');
    expect(doc.querySelector('motor > designation')!.textContent).toBe('C6');
    expect(doc.querySelector('motor > mmrexmotorid')!.textContent).toBe('ex:test-c6');
    expect(xml).not.toContain('<digest>');
  });

  it('archives the loaded curve when its library curve changes', async () => {
    const { tree, mount, xml } = saved();
    const motor = (await matchImportedMotor(Object.values(importOrk(xml).motors)[0]!)).motor!;
    addExMotors([{ ...synthetic(), samples: synthetic().samples.map(s => ({ ...s, thrust: s.thrust * 2 })) }]);
    const write = () => exportOrk({ name: 'Changed library', tree,
      motors: { [mount]: toOrkMotor(motor, undefined, loadExMotors) } });
    expect(write).not.toThrow();
    expect(importOrk(write()).embeddedExMotors).toEqual([synthetic()]);
    addExMotors([synthetic()]);
    expect(write).not.toThrow();
  });

  it('warns on failed persistence but keeps the embedded motor usable this session', async () => {
    const { xml } = saved();
    localStorage.clear();
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage),
      setItem: () => { throw new Error('quota'); }, get length() { return 0; } });
    const opened = importOrk(xml);
    expect(opened.notes.join(' ')).not.toContain('not saved in browser storage');
    restoreExMotors(opened.embeddedExMotors!, opened.notes);
    expect(opened.notes.join(' ')).toContain('not saved in browser storage');
    expect((await matchImportedMotor(Object.values(opened.motors)[0]!)).motor).toBeDefined();
    vi.unstubAllGlobals();
    deleteExMotor(synthetic().motorId); // also clears the in-memory unstored fallback
  });
});

describe('hostile EX archives', () => {
  it('drops an empty EX reference with a persistent save note', async () => {
    const { xml } = saved();
    const opened = importOrk(xml.replace('<mmrexmotorid>ex:test-c6</mmrexmotorid>', '<mmrexmotorid></mmrexmotorid>'));
    const r = Object.values(opened.motors)[0]!;
    expect(r.exMotorMissing).toBe(true);
    expect((await matchImportedMotor(r)).motor).toBeUndefined();
    const again = exportOrk({ name: opened.name, tree: opened.tree, motors: { [r.mountId!]: refToExportMotor(r) } });
    expect(Object.values(importOrk(again).motors)).toEqual([]);
    expect(importOrk(again).notes.join(' ')).toContain('without this motor');
  });
  const invalid: [string, (m: ExMotor) => unknown][] = [
    ['non-object', () => null],
    ['id namespace', m => ({ ...m, motorId: '__proto__' })],
    ['id length', m => ({ ...m, motorId: `ex:${'x'.repeat(1024)}` })],
    ['designation', m => ({ ...m, designation: '' })],
    ['manufacturer', m => ({ ...m, realManufacturer: 1 })],
    ['delays', m => ({ ...m, delays: [] })],
    ['diameter', m => ({ ...m, diameter: -1, exitDiameterM: undefined })],
    ['length', m => ({ ...m, length: 0 })],
    ['loaded mass', m => ({ ...m, totalWeightG: Infinity, sampleMassesKg: undefined })],
    ['propellant mass', m => ({ ...m, propWeightG: -1, sampleMassesKg: undefined })],
    ['mass pair', m => ({ ...m, propWeightG: 25 })],
    ['date', m => ({ ...m, addedAt: Infinity })],
    ['source', m => ({ ...m, source: 'json' })],
    ['sample count lower', m => ({ ...m, samples: [m.samples[0]], sampleMassesKg: undefined })],
    ['sample count upper', m => ({ ...m, samples: Array.from({ length: MAX_EX_MOTOR_SAMPLES + 1 }, () => ({ time: 0, thrust: 0 })) , sampleMassesKg: undefined })],
    ['sample time', m => ({ ...m, samples: [{ time: NaN, thrust: 0 }, ...m.samples.slice(1)] })],
    ['sample thrust', m => ({ ...m, samples: [{ time: 0, thrust: Infinity }, ...m.samples.slice(1)] })],
    ['mass count', m => ({ ...m, sampleMassesKg: [0.024] })],
    ['mass finite', m => ({ ...m, sampleMassesKg: [0.024, NaN, 0.018, 0.014] })],
    ['mass type', m => ({ ...m, sampleMassesKg: [0.024, '0.022', 0.018, 0.014] })],
    ['mass negative', m => ({ ...m, sampleMassesKg: [0.024, -1, 0.018, 0.014] })],
    ['mass below case', m => ({ ...m, sampleMassesKg: [0.024, 0.022, 0.018, 0.001] })],
    ['mass above loaded', m => ({ ...m, sampleMassesKg: [1, 0.022, 0.018, 0.014] })],
    ['exit finite', m => ({ ...m, exitDiameterM: Infinity })],
    ['exit type', m => ({ ...m, exitDiameterM: '0.005' })],
    ['exit low', m => ({ ...m, exitDiameterM: 0.001 })],
    ['exit high', m => ({ ...m, exitDiameterM: 0.017 })],
  ];
  it.each(invalid)('refuses %s with a note and never loads an existing or catalogue twin', async (_name, damage) => {
    const { xml } = saved();
    const broken = damage(synthetic());
    expect(validArchivedExMotor(broken)).toBe(false);
    const opened = importOrk(payload(xml, [broken]));
    expect(opened.notes.join(' ')).toContain('Embedded EX motors were refused');
    const findDb = vi.fn();
    expect((await matchImportedMotor(Object.values(opened.motors)[0]!, { findDb })).motor).toBeUndefined();
    expect(findDb).not.toHaveBeenCalled();
    expect(loadExMotors()).toEqual([synthetic()]);
  });

  it.each(['duplicate ids', 'motor count', 'bytes', 'version', 'repeated', 'NaN', 'missing'])(
    'refuses %s without any library write', async kind => {
      const { xml } = saved();
      let bad = xml;
      if (kind === 'duplicate ids') bad = payload(xml, [synthetic(), synthetic()]);
      if (kind === 'motor count') bad = payload(xml, Array.from({ length: MAX_EMBEDDED_EX_MOTORS + 1 }, (_, i) => ({ ...synthetic(), motorId: `ex:${i}` })));
      if (kind === 'bytes') bad = payload(xml, [{ ...synthetic(), designation: 'é'.repeat(MAX_EX_ARCHIVE_BYTES / 2) }]);
      if (kind === 'version') bad = xml.replace('mmrexmotors version="1"', 'mmrexmotors version="2"');
      if (kind === 'repeated') bad = xml.replace('</rocket>', '<mmrexmotors version="1">[]</mmrexmotors></rocket>');
      if (kind === 'NaN') bad = xml.replace('&quot;diameter&quot;:18', '&quot;diameter&quot;:NaN');
      if (kind === 'missing') bad = xml.replace(/<mmrexmotors[^]*?<\/mmrexmotors>/, '');
      localStorage.clear();
      const opened = importOrk(bad);
      if (kind !== 'missing') expect(opened.notes.join(' ')).toContain('Embedded EX motors were refused');
      expect(loadExMotors()).toEqual([]);
      expect((await matchImportedMotor(Object.values(opened.motors)[0]!)).motor).toBeUndefined();
    });

  it('saves without missing, invalid or over-budget definitions, with notes', () => {
    const notes: string[] = [];
    expect(archiveExMotors([ref()], notes).json).toBeNull();
    expect(notes.join(' ')).toContain('no valid loaded snapshot');
    addExMotors([{ ...synthetic(), totalWeightG: -1 }]);
    expect(archiveExMotors([ref()], []).json).toBeNull();
    addExMotors([{ ...synthetic(), designation: 'x'.repeat(MAX_EX_ARCHIVE_BYTES) }]);
    expect(archiveExMotors([ref()], notes).json).toBeNull();
    expect(notes.join(' ')).toContain('disk archive budget');
    deleteExMotor(synthetic().motorId);
    const many = Array.from({ length: MAX_EMBEDDED_EX_MOTORS + 1 }, (_, i) => ({ ...synthetic(), motorId: 'ex:' + i, designation: 'C' + i }));
    addExMotors(many);
    const archive = archiveExMotors(many.map(m => ref(m)), notes);
    expect(JSON.parse(archive.json!)).toHaveLength(MAX_EMBEDDED_EX_MOTORS);
    expect([...archive.ids.values()].filter(id => id === null)).toHaveLength(1);
  });

  it('shares the sample-count cap with .eng and .rse imports', () => {
    const count = MAX_EX_MOTOR_SAMPLES + 1;
    expect(() => parseEng('C6 18 70 P 0.01 0.024 Test\n' + '0 1\n'.repeat(count))).toThrow(/100000 thrust samples/);
    expect(() => parseEng('C6 18 70 P 0.01 0.024 Test\n' + '0 1\n'.repeat(count) + 'NaN 1\n')).toThrow(/100000 thrust samples/);
    expect(() => parseEng('C6 18 70 P 0.01 0.024 Test\n' + '1 1\n'.repeat(MAX_EX_MOTOR_SAMPLES))).toThrow(/100000 thrust samples/);
    const xml = '<engine-database><engine-list><engine code="C6" dia="18" len="70" initWt="24" propWt="10"><data>'
      + '<eng-data t="0" f="1"/>'.repeat(count) + '</data></engine></engine-list></engine-database>';
    // happy-dom silently stops parsing siblings at 65536. Exercise this
    // 100001-point boundary using the production headless XML parser.
    const parser = currentXmlParser();
    setXmlParser(jsXmlParser);
    try { expect(() => parseRse(xml)).toThrow(/100000 thrust samples/); }
    finally { setXmlParser(parser); }
  });
});
