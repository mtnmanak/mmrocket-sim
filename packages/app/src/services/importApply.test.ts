import { describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import { LEGACY_PAD_MASS_KEY, motorIdentity, motorSetIdentity } from './hardwareMass.js';
import type { MotorMatchResult } from './motorMatch.js';
import type { OrkFlightConfig, OrkMotorRef } from './orkFile.js';
import { padMassSetKey } from './configSync.js';
import {
  importedLaunch, importMark, openShareLink, planConfigSwitch, planImport, planNewDesign, planOrkSave,
  resolveImportMotors, starterMotorMayLand, type ImportedDesign, type ResolvedImportMotors,
} from './importApply.js';
import { createSequencer } from './latestWins.js';
import { updateNode } from '../tree/treeModel.js';

/**
 * What an Open, a configuration switch and ✕ New put on screen (audit
 * 2026-09-22, extraction #3). These were ~370 lines of App.tsx that no test
 * could reach, and two of their rules were written twice there — the launch
 * merge and the pad-mass key — so the saved mark and the state it describes
 * could be assembled apart. Every plan here is what App applies AND what it
 * marks from.
 */

const TEXT = {
  mass: (kg: number) => `${(kg * 1000).toFixed(0)} g`,
  length: (m: number) => `${(m * 1000).toFixed(1)} mm`,
};

const motor = (designation: string, motorId = `db-${designation}`): MountMotor => ({
  label: `${designation}-10`,
  spec: {
    designation, diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: 10,
    times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1],
  },
  meta: { label: designation, manufacturer: 'AeroTech', motorId },
  ignition: { event: 'automatic', delay: 0 },
});

const ref = (designation: string): OrkMotorRef => ({
  designation, manufacturer: 'AeroTech', diameter: 0.029, length: 0.2, delay: 10,
});

/** A stage whose motor mount sits inside a pod set of TWO: the kernel flies two motors. */
const podTree = (): RocketTree => ({
  name: 'Pods',
  components: [{
    type: 'stage', id: 'st', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', length: 0.5, outerRadius: 0.03, thickness: 0.001,
      children: [{
        type: 'podset', id: 'pods', instanceCount: 2, radiusOffset: 0.05,
        children: [{
          type: 'bodytube', id: 'podtube', length: 0.3, outerRadius: 0.016, thickness: 0.001,
          children: [{
            type: 'innertube', id: 'mmt', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true,
          } as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode],
});

const config = (id: string, motors: Record<string, OrkMotorRef>, extra: Partial<OrkFlightConfig> = {}): OrkFlightConfig => ({
  id, name: id, isDefault: false, motors, deployments: {}, separations: {}, ...extra,
});

/** Every reference resolves to the catalogue motor of the same designation. */
const resolvedAll = (imported: ImportedDesign): ResolvedImportMotors => ({
  working: Object.fromEntries(Object.entries(imported.motors).map(([id, r]) => [id, { motor: motor(r.designation), note: '' }])),
  configs: Object.fromEntries((imported.configs ?? []).filter((c) => c.id !== imported.chosenConfigId)
    .map((c) => [c.id, Object.fromEntries(Object.entries(c.motors).map(([id, r]) => [id, motor(r.designation)]))])),
});

const LAUNCH: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 4 };

describe('importedLaunch — THE launch merge', () => {
  it('applies every field the file carried, explicit nulls included, and keeps the rest', () => {
    const prev: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 4, temperatureC: 27 };
    const next = importedLaunch(prev, { launchRodAngleDeg: 5, temperatureC: null });
    expect(next.windAverage).toBe(4);
    expect(next.launchRodAngleDeg).toBe(5);
    expect(next.temperatureC).toBeNull();
  });

  it('always assigns the time step: a file without one goes back to the default', () => {
    const prev = { ...DEFAULT_CONDITIONS, timeStepS: 0.01 };
    expect(importedLaunch(prev, {}).timeStepS).toBeUndefined();
    expect(importedLaunch(prev, undefined).timeStepS).toBeUndefined();
    expect(importedLaunch(prev, { timeStepS: 0.02 }).timeStepS).toBe(0.02);
  });
});

describe('resolveImportMotors — the awaits of an open', () => {
  it('matches the applied set once and every OTHER configuration after it, in file order', async () => {
    const imported: ImportedDesign = {
      name: 'x', tree: podTree(), notes: [], motors: { mmt: ref('H100') },
      configs: [config('A', { mmt: ref('H100') }), config('B', { mmt: ref('I200') })],
      chosenConfigId: 'A',
    };
    const seen: string[] = [];
    const match = vi.fn(async (r: OrkMotorRef): Promise<MotorMatchResult> => {
      seen.push(r.designation);
      return { motor: motor(r.designation), note: '' };
    });
    const out = await resolveImportMotors(imported, match);
    // The applied configuration is not fetched a second time.
    expect(seen).toEqual(['H100', 'I200']);
    expect(Object.keys(out.configs)).toEqual(['B']);
    expect(out.configs['B']!['mmt']!.spec.designation).toBe('I200');
  });
});

describe('planImport — one plan, applied and marked', () => {
  it('marks exactly what it writes, so a fresh file reads clean', () => {
    const imported: ImportedDesign = {
      name: 'x', tree: podTree(), notes: ['from the reader'], motors: { mmt: ref('H100') },
      launch: { windAverage: 9 },
      measured: { massKg: 1.2, cgM: 0.3 },
    };
    const plan = planImport(imported, resolvedAll(imported), { launch: LAUNCH, text: TEXT });
    expect(importMark(plan)).toBe(designFingerprint(plan.snapshot));
    expect(isDirty(designFingerprint(plan.snapshot), importMark(plan), false)).toBe(false);
    // The launch in the snapshot is THE merge rule's, from the launch handed in.
    expect(plan.snapshot.launch).toEqual(importedLaunch(LAUNCH, imported.launch));
    expect(plan.snapshot.measured).toEqual({ massKg: 1.2, cgM: 0.3 });
    expect(plan.snapshot.maxMotorLengthByStage).toEqual({});
    expect(plan.note.severity).toBe('info');
    expect(plan.note.text.split('\n')[0]).toBe('Loaded “x”.');
  });

  it('keeps an unmatched reference whole, says so, and reads as a warning', () => {
    const imported: ImportedDesign = { name: 'x', tree: podTree(), notes: [], motors: { mmt: ref('Z9999') } };
    const plan = planImport(imported, {
      working: { mmt: { note: 'Motor “Z9999” is not in the motor database.' } }, configs: {},
    }, { launch: LAUNCH, text: TEXT });
    expect(plan.snapshot.mountMotors).toEqual({});
    expect(plan.unmatchedRefs['mmt']!.designation).toBe('Z9999');
    expect(plan.note.severity).toBe('warn');
    expect(plan.note.text).toContain('Z9999');
  });

  it('keeps a LOADED motor\'s match note out of the import note', () => {
    // Only a motor that did not load is news here: the vitals strip and the
    // Motors tab show a loaded one live, and this note is never rewritten.
    const imported: ImportedDesign = { name: 'x', tree: podTree(), notes: [], motors: { mmt: ref('H100') } };
    const plan = planImport(imported, {
      working: { mmt: { motor: motor('H100'), note: 'Motor “H100” loaded from the motor database.' } }, configs: {},
    }, { launch: LAUNCH, text: TEXT });
    expect(plan.snapshot.mountMotors['mmt']).toBeDefined();
    expect(plan.note.text).not.toContain('loaded from the motor database');
    expect(plan.note.severity).toBe('info');
  });

  it('clears the previous rocket’s measured figures when the file carries none', () => {
    const imported: ImportedDesign = { name: 'x', tree: podTree(), notes: [], motors: {} };
    const plan = planImport(imported, resolvedAll(imported), { launch: LAUNCH, text: TEXT });
    expect(plan.snapshot.measured).toEqual({ massKg: null, cgM: null });
  });

  /**
   * THE pad-mass key rule, once. The set on screen is keyed by
   * configSync.padMassSetKey; an imported pad mass must be stored under the
   * same key or hardwareMass reads it as weighed with a different set the
   * moment the file opens. A pod set of two is the case that rule is for: the
   * kernel flies two motors from one mount, where the mount's cluster says one.
   */
  it('keys an imported pad mass by the rule the set on screen is keyed by', () => {
    const imported: ImportedDesign = {
      name: 'x', tree: podTree(), notes: [], motors: { mmt: ref('H100') },
      configs: [config('A', { mmt: ref('H100') }, { padMassKg: 1.5 })],
      chosenConfigId: 'A',
    };
    const plan = planImport(imported, resolvedAll(imported), { launch: LAUNCH, text: TEXT });
    const rec = plan.snapshot.mountMotors['mmt']!;
    expect(rec.padMassKg).toBe(1.5);
    expect(rec.padMassWeighedWith).toBe(padMassSetKey(plan.snapshot.tree, plan.snapshot.mountMotors));
    expect(rec.padMassWeighedWith).toBe(motorSetIdentity([['mmt', motorIdentity(rec.meta, 'H100'), 2]]));
    // The configuration's own record carries the same value and key.
    expect(plan.snapshot.savedConfigs[0]!.motors['mmt']).toEqual(rec);
  });

  it('keys a pad mass on a half-loaded set with the unmatched sentinel, and the v0.116 form legacy', () => {
    const imported: ImportedDesign = {
      name: 'x', tree: podTree(), notes: [], motors: { mmt: ref('H100') },
      configs: [config('A', { mmt: ref('H100') }, { padMassKg: 1.5, padMassLegacy: true })],
      chosenConfigId: 'A',
    };
    const legacy = planImport(imported, resolvedAll(imported), { launch: LAUNCH, text: TEXT });
    expect(legacy.snapshot.mountMotors['mmt']!.padMassWeighedWith).toBe(LEGACY_PAD_MASS_KEY);

    const unmatched = planImport({ ...imported, configs: [config('A', { mmt: ref('Z1') }, { padMassKg: 1.5 })], motors: { mmt: ref('Z1') } },
      { working: { mmt: { note: 'no Z1' } }, configs: {} }, { launch: LAUNCH, text: TEXT });
    // No record to carry it: the value stays on the reference so Save writes it back.
    expect(unmatched.unmatchedRefs['mmt']!.padMassKg).toBe(1.5);
    expect(unmatched.note.text).toContain('could not be loaded');
  });
});

describe('planConfigSwitch — one switch, applied and noted', () => {
  const tree = (): RocketTree => ({
    name: 'two',
    components: [
      { type: 'stage', id: 's1', name: 'Sustainer', children: [
        { type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'innertube', id: 'm1', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
          { type: 'parachute', id: 'chute', diameter: 0.5, deployEvent: 'apogee', deployDelay: 0 } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode,
      { type: 'stage', id: 's2', name: 'Booster', separationEvent: 'ejection', separationDelay: 0, children: [
        { type: 'bodytube', id: 'b2', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'innertube', id: 'm2', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode,
    ],
  });
  const A: SavedConfig = { id: 'A', name: 'A', isDefault: true, motors: { m1: motor('H100'), m2: motor('I200') } };
  const B: SavedConfig = {
    id: 'B', name: 'B', isDefault: false, motors: { m1: motor('H100'), m2: motor('J300') },
    deployments: { chute: { deployEvent: 'altitude', deployAltitude: 150 } },
    separations: { s2: { separationEvent: 'bogus-event', separationDelay: 1.5 } },
    nozzles: { s2: 0.02 },
  };

  it('writes the working set back into the configuration being left, then applies the target', () => {
    const working = { ...A.motors, m1: { ...A.motors['m1']!, label: 'H100-14' } };
    const plan = planConfigSwitch({
      savedConfigs: [A, B], activeConfigId: 'A', mountMotors: working, unmatchedRefs: {}, tree: tree(),
    }, B, TEXT);
    expect(plan.savedConfigs[0]!.motors['m1']!.label).toBe('H100-14');
    expect(plan.savedConfigs[1]).toBe(B);
    expect(plan.mountMotors).toBe(B.motors);
    expect(plan.activeConfigId).toBe('B');
    expect(plan.unmatchedRefs).toEqual({});
    // A configuration that states no nozzle (an .ork) seeds nothing: its motor
    // change is a real one, and the nozzle follows it.
    expect(planConfigSwitch({
      savedConfigs: [B, A], activeConfigId: 'B', mountMotors: B.motors, unmatchedRefs: {}, tree: tree(),
    }, A, TEXT).nozzleStated).toEqual([]);
  });

  it('puts the configuration’s deployment, separation and nozzle on the tree, the event in the kernel’s spelling', () => {
    const plan = planConfigSwitch({
      savedConfigs: [A, B], activeConfigId: 'A', mountMotors: A.motors, unmatchedRefs: {}, tree: tree(),
    }, B, TEXT);
    const chute = plan.tree.components[0]!.children![0]!.children![1]!;
    expect(chute['deployEvent']).toBe('altitude');
    expect(chute['deployAltitude']).toBe(150);
    const booster = plan.tree.components[1]!;
    expect(booster['separationEvent']).toBe('ejection');
    expect(booster['separationDelay']).toBe(1.5);
    expect(booster['nozzleExitDiameter']).toBe(0.02);
    // The stage whose nozzle B states, under B's loadout — for the nozzle-follow
    // seed (audit 2026-09-22). The sustainer's nozzle is not B's to state.
    expect(plan.nozzleStated.map((st) => [st.stageId, st.motors.map((m) => m.motorId)]))
      .toEqual([['s2', ['db-J300']]]);
    expect(plan.note).toEqual({
      text: 'Flight configuration “B” applied — its motors and recovery settings are now live.',
      severity: 'info',
    });
  });

  it('names an unmatched motor as the debt that comes due on applying', () => {
    const C: SavedConfig = { id: 'C', name: 'C', isDefault: false, motors: {}, unmatched: ['Z1'], unmatchedRefs: { m1: ref('Z1') } };
    const plan = planConfigSwitch({
      savedConfigs: [A, C], activeConfigId: 'A', mountMotors: A.motors, unmatchedRefs: {}, tree: tree(),
    }, C, TEXT);
    expect(plan.unmatchedRefs).toEqual({ m1: ref('Z1') });
    expect(plan.note.severity).toBe('warn');
    expect(plan.note.text).toContain('Motor “Z1” couldn\'t be matched');
  });
});

/**
 * A→B→A KEEPS WHAT WAS EDITED ON A (audit 2026-09-22). Only the motors were
 * written back into the configuration being left, so a chute deployment or a
 * nozzle changed in the app on A came back as the FILE's after a round trip,
 * and the next Launch on A flew the file's deployment.
 */
describe('planConfigSwitch — the round trip', () => {
  const tree = (): RocketTree => ({
    name: 'two',
    components: [
      { type: 'stage', id: 's1', name: 'Sustainer', children: [
        { type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'innertube', id: 'm1', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
          { type: 'parachute', id: 'chute', diameter: 0.5, deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode,
      { type: 'stage', id: 's2', name: 'Booster', nozzleExitDiameter: 0.03, children: [
        { type: 'bodytube', id: 'b2', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'innertube', id: 'm2', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode,
    ],
  });
  const A: SavedConfig = {
    id: 'A', name: 'A', isDefault: true, motors: { m1: motor('H100'), m2: motor('M1350') },
    deployments: { chute: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } }, nozzles: { s2: 0.03 },
  };
  const B: SavedConfig = {
    id: 'B', name: 'B', isDefault: false, motors: { m1: motor('H100'), m2: motor('K627') },
    deployments: { chute: { deployEvent: 'altitude', deployAltitude: 300, deployDelay: 0 } }, nozzles: { s2: 0.0254 },
  };

  it('brings back the deployment and nozzle edited on A, not the file’s', () => {
    // On A, the user moves the chute to 90 m on a 1 s delay and corrects the booster exit.
    let t = updateNode(tree(), 'chute', { deployDelay: 1, deployAltitude: 90, deployEvent: 'altitude' });
    t = { ...t, components: t.components.map((st) => (st.id === 's2' ? { ...st, nozzleExitDiameter: 0.032 } : st)) };
    const toB = planConfigSwitch({ savedConfigs: [A, B], activeConfigId: 'A', mountMotors: A.motors, unmatchedRefs: {}, tree: t }, B, TEXT);
    expect(toB.tree.components[1]!['nozzleExitDiameter']).toBe(0.0254);
    // What a Save while B is active writes for A: the edit, not the file's 200.
    expect(toB.savedConfigs[0]!.deployments!['chute']).toEqual({ deployEvent: 'altitude', deployAltitude: 90, deployDelay: 1 });
    const backToA = planConfigSwitch({
      savedConfigs: toB.savedConfigs, activeConfigId: 'B', mountMotors: toB.mountMotors, unmatchedRefs: {}, tree: toB.tree,
    }, toB.savedConfigs[0]!, TEXT);
    const chute = backToA.tree.components[0]!.children![0]!.children![1]!;
    expect(chute['deployAltitude']).toBe(90);
    expect(chute['deployDelay']).toBe(1);
    expect(chute['deployEvent']).toBe('altitude');
    expect(backToA.tree.components[1]!['nozzleExitDiameter']).toBe(0.032);
    // B, untouched in between, is written back as it was.
    expect(backToA.savedConfigs[1]!.deployments).toEqual(B.deployments);
  });
});

describe('planOrkSave — the mark a .ork save takes', () => {
  it('reads clean after a switch away and back, with no edit in between', () => {
    const tree: RocketTree = {
      name: 'r',
      components: [{ type: 'stage', id: 's1', name: 'Sustainer', children: [
        { type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001, children: [
          { type: 'innertube', id: 'm1', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
          { type: 'parachute', id: 'chute', deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode],
    };
    const A: SavedConfig = { id: 'A', name: 'A', isDefault: true, motors: { m1: motor('H100') },
      deployments: { chute: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } } };
    const B: SavedConfig = { id: 'B', name: 'B', isDefault: false, motors: { m1: motor('I200') },
      deployments: { chute: { deployEvent: 'altitude', deployAltitude: 250, deployDelay: 0 } } };
    // Edited on A, then saved.
    const onA = updateNode(tree, 'chute', { deployAltitude: 150, deployEvent: 'altitude' });
    const working = { m1: { ...A.motors['m1']!, label: 'H100-14' } };
    const snap: DesignSnapshot = {
      tree: onA, mountMotors: working, launch: LAUNCH, maxMotorLengthByStage: {},
      savedConfigs: [A, B], activeConfigId: 'A', measured: { massKg: null, cgM: null },
    };
    const saved = planOrkSave(snap, {});
    expect(saved.mark).toBe(designFingerprint({ ...snap, savedConfigs: saved.savedConfigs }));
    // A→B→A.
    const toB = planConfigSwitch({ savedConfigs: saved.savedConfigs, activeConfigId: 'A', mountMotors: working, unmatchedRefs: {}, tree: onA }, B, TEXT);
    const back = planConfigSwitch({ savedConfigs: toB.savedConfigs, activeConfigId: 'B', mountMotors: toB.mountMotors, unmatchedRefs: {}, tree: toB.tree },
      toB.savedConfigs[0]!, TEXT);
    const after: DesignSnapshot = {
      ...snap, tree: back.tree, mountMotors: back.mountMotors, savedConfigs: back.savedConfigs, activeConfigId: back.activeConfigId,
    };
    expect(isDirty(designFingerprint(after), saved.mark, false)).toBe(false);
  });
});

describe('planNewDesign — ✕ New marks what it writes', () => {
  it('takes the mark over the very tree it hands back, launch and measured carried', () => {
    const measured = { massKg: 0.5, cgM: 0.2 };
    const { snapshot, mark } = planNewDesign({ launch: LAUNCH, measured });
    expect(mark).toBe(designFingerprint(snapshot));
    expect(snapshot.tree.components).toHaveLength(1);
    expect(snapshot.launch).toBe(LAUNCH);
    expect(snapshot.measured).toBe(measured);
    expect(snapshot.mountMotors).toEqual({});
    expect(snapshot.savedConfigs).toEqual([]);
    expect(snapshot.activeConfigId).toBeNull();
  });
});

/**
 * THE OPEN SEQUENCE (audit 2026-09-22). An open is asynchronous — a file
 * read, the preset catalogue, a thrustcurve.org fetch per unmatched motor — so
 * only the newest may write. Three paths broke that: ✕ New never claimed the
 * sequence, the share link claimed it only after its awaits, and the starter
 * rocket's C6 landed on whatever design was on screen when its curve arrived.
 */
describe('the open sequence', () => {
  it('✕ New supersedes an open still in flight', () => {
    const seq = createSequencer();
    const inFlight = seq.begin();
    planNewDesign({ launch: LAUNCH, measured: { massKg: null, cgM: null } }, seq);
    expect(seq.isCurrent(inFlight)).toBe(false);
  });

  const deps = (seq: ReturnType<typeof createSequencer>, read: () => Promise<ImportedDesign>, offer = false) => ({
    openSeq: seq, read, offer,
    onOffer: vi.fn(), apply: vi.fn(async () => {}), onError: vi.fn(),
  });
  const linked: ImportedDesign = { name: 'linked', tree: podTree(), notes: [], motors: {} };

  it('a share link claims the sequence before its first await', () => {
    const seq = createSequencer();
    const earlier = seq.begin();
    void openShareLink('#d=x', deps(seq, () => new Promise(() => {})));
    // Synchronously, before the decode has even started.
    expect(seq.isCurrent(earlier)).toBe(false);
  });

  it('a share link superseded while decoding neither offers, applies nor reports', async () => {
    const seq = createSequencer();
    let finish: (d: ImportedDesign) => void = () => {};
    const d = deps(seq, () => new Promise((r) => { finish = r; }));
    const done = openShareLink('#d=x', d);
    seq.begin(); // the user opens a file meanwhile
    finish(linked);
    await done;
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.onOffer).not.toHaveBeenCalled();
    const failing = deps(seq, async () => { seq.begin(); throw new Error('cut short'); });
    await openShareLink('#d=y', failing);
    expect(failing.onError).not.toHaveBeenCalled();
  });

  it('a current share link applies under its own claim, offers when asked to, and reports a bad link', async () => {
    const seq = createSequencer();
    const d = deps(seq, async () => linked);
    await openShareLink('#d=x', d);
    expect(d.apply).toHaveBeenCalledTimes(1);
    const [applied, openId] = d.apply.mock.calls[0] as unknown as [ImportedDesign, number];
    expect(applied).toBe(linked);
    expect(seq.isCurrent(openId)).toBe(true);
    const o = deps(seq, async () => linked, true);
    await openShareLink('#d=x', o);
    expect(o.onOffer).toHaveBeenCalledWith(linked);
    expect(o.apply).not.toHaveBeenCalled();
    const bad = deps(seq, async () => { throw new Error('cut short'); });
    await openShareLink('#d=x', bad);
    expect(bad.onError).toHaveBeenCalledTimes(1);
  });

  it('the starter C6 lands only on the starter mount still on screen, with nothing loaded', () => {
    const starter = podTree();
    expect(starterMotorMayLand(starter, 'mmt', {})).toBe(true);
    expect(starterMotorMayLand(starter, 'mmt', { mmt: motor('C6') })).toBe(false);
    // ✕ New or an Open replaced the design: fresh ids, the starter mount is gone.
    const replaced = planNewDesign({ launch: LAUNCH, measured: { massKg: null, cgM: null } }).snapshot.tree;
    expect(starterMotorMayLand(replaced, 'mmt', {})).toBe(false);
  });
});
