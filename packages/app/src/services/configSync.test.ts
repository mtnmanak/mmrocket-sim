import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import type { OrkMotorRef } from './orkFile.js';
import { designFingerprint, type DesignSnapshot } from './dirtyState.js';
import { LEGACY_PAD_MASS_KEY } from './hardwareMass.js';
import {
  adoptsRefPadMass, assignMotorRecord, migrateLegacyPadMass, restoreUnmatchedRefs, stripPadMass, stripRefPadMass,
  withActiveConfigSynced, withoutStoredRef,
} from './configSync.js';

/**
 * The working motor set written back into its flight configuration (v0.118).
 * Until now `savedConfigs` was written only at init / New / import, so a
 * delay edit — and now the weighed pad mass — was lost on A→B→A and reached
 * the file only when saved with its own configuration on screen; and the
 * working set's unmatched references were not persisted, so a reload's only
 * copy was the configuration's. Every case here is one of those lifecycles.
 */

const motor = (designation: string, delay = 10): MountMotor => ({
  label: `${designation}-${delay}`,
  spec: {
    designation, diameter: 0.054, length: 0.41, cgX: 0.2, ejectionDelay: delay,
    times: [0, 1], thrusts: [0, 0], masses: [1.084, 0.6],
  },
  meta: { label: designation, manufacturer: 'AeroTech' },
  ignition: { event: 'automatic', delay: 0 },
});

const ref = (designation: string): OrkMotorRef => ({
  designation, manufacturer: 'Loki', diameter: 0.075, length: 0.6, delay: 0, digest: `d-${designation}`,
});

const cfg = (id: string, motors: Record<string, MountMotor>, extra: Partial<SavedConfig> = {}): SavedConfig => ({
  id, name: id, isDefault: id === 'A', motors, ...extra,
});

/** Two stages: sustainer mount 's-mmt' (stage 0), booster mount 'b-mmt' (stage 1). */
const twoStage = (): RocketTree => ({
  name: 'two',
  components: [
    {
      type: 'stage', id: 's1', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 's-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005, motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
    {
      type: 'stage', id: 's2', name: 'Booster',
      children: [{
        type: 'bodytube', id: 'b2', length: 0.5, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 'b-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005, motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
  ],
});

const snapshot = (
  mountMotors: Record<string, MountMotor>, savedConfigs: SavedConfig[], activeConfigId: string | null,
): DesignSnapshot => ({
  tree: twoStage(),
  mountMotors,
  launch: { windAvg: 3, timeStepS: 0.01 } as unknown as DesignSnapshot['launch'],
  maxMotorLengthByStage: {},
  savedConfigs,
  activeConfigId,
  measured: { massKg: null, cgM: null },
});

const KEY = '[["s-mmt","AeroTech/J540R",1]]';

describe('withActiveConfigSynced', () => {
  it('writes the working set into the active configuration and leaves the others by identity', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, {
      separations: { s2: { event: 'launch', delay: 0 } } as unknown as SavedConfig['separations'],
      deployments: { chute: { event: 'apogee' } } as unknown as SavedConfig['deployments'],
      nozzles: { s1: 0.05 },
    });
    const B = cfg('B', { 's-mmt': motor('I284W') });
    const configs = [A, B];
    // A delay edit and a pad mass typed on A.
    const working: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R', 7), padMassKg: 10.574, padMassWeighedWith: KEY },
    };
    const out = withActiveConfigSynced(configs, 'A', working, {});
    expect(out).not.toBe(configs);
    expect(out[0]!.motors).toBe(working);             // verbatim, not copied
    expect(out[0]!.motors['s-mmt']!.spec.ejectionDelay).toBe(7);
    expect(out[0]!.motors['s-mmt']!.padMassKg).toBe(10.574);
    // Everything else on the row survives: id, name, default, separations, deployments, nozzles.
    expect(out[0]).toMatchObject({ id: 'A', name: 'A', isDefault: true });
    expect(out[0]!.separations).toBe(A.separations);
    expect(out[0]!.deployments).toBe(A.deployments);
    expect(out[0]!.nozzles).toBe(A.nozzles);
    // The other row is the SAME object, and the input array is untouched.
    expect(out[1]).toBe(B);
    expect(configs[0]).toBe(A);
    expect(A.motors['s-mmt']!.spec.ejectionDelay).toBe(10);
    // A record for a mount the tree no longer has rides along verbatim — an
    // undo-restored mount keeps its motor; the export gate ignores it.
    const withStale = { ...working, gone: motor('G80') };
    expect(withActiveConfigSynced(configs, 'A', withStale, {})[0]!.motors).toBe(withStale);
  });

  it('returns the input by identity when the active configuration already equals the working set (designFingerprint equality)', () => {
    const A = cfg('A', { 's-mmt': motor('J540R'), 'b-mmt': motor('I284W') });
    const configs = [A, cfg('B', { 's-mmt': motor('I284W') })];
    // A structurally equal working set built in the OTHER key order — an
    // import writes file order, editing writes click order.
    const working: Record<string, MountMotor> = {};
    working['b-mmt'] = { ...motor('I284W') };
    working['s-mmt'] = { ...motor('J540R') };
    expect(Object.keys(working).join()).not.toBe(Object.keys(A.motors).join());
    expect(withActiveConfigSynced(configs, 'A', working, {})).toBe(configs);
    expect(designFingerprint(snapshot(working, withActiveConfigSynced(configs, 'A', working, {}), 'A')))
      .toBe(designFingerprint(snapshot(working, configs, 'A')));
    // Stored refs equal to the working refs: identity too.
    const withRefs = [cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } })];
    expect(withActiveConfigSynced(withRefs, 'A', { 's-mmt': motor('J540R') }, { 'b-mmt': { ...ref('K1100T') } })).toBe(withRefs);
    // A row imported with `unmatched: []` and no refs is "already equal" to an
    // empty working set: absent and empty are the same stored fact.
    const emptyList = [cfg('A', { 's-mmt': motor('J540R') }, { unmatched: [] })];
    expect(withActiveConfigSynced(emptyList, 'A', { 's-mmt': motor('J540R') }, {})).toBe(emptyList);
  });

  it('replaces unmatched/unmatchedRefs: deletes both when the working refs are empty, derives unmatched in insertion order otherwise', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    // The K1100T was loaded since: the working refs are empty, so BOTH keys
    // go — a `...c` spread alone would have left `unmatched: ['K1100T']`
    // beside nothing, and the applied note would still name it.
    const loaded = withActiveConfigSynced([A], 'A', { 's-mmt': motor('J540R'), 'b-mmt': motor('K1100T') }, {});
    expect('unmatched' in loaded[0]!).toBe(false);
    expect('unmatchedRefs' in loaded[0]!).toBe(false);
    // Two working refs, written booster-first: `unmatched` follows that order,
    // the order applyImported wrote them.
    const refs: Record<string, OrkMotorRef> = {};
    refs['b-mmt'] = ref('K1100T');
    refs['a-mmt'] = ref('J350W');
    const two = withActiveConfigSynced([A], 'A', { 's-mmt': motor('J540R') }, refs);
    expect(two[0]!.unmatched).toEqual(['K1100T', 'J350W']);
    expect(two[0]!.unmatchedRefs).toBe(refs);
  });

  it('a reload does not cost a configuration its unmatched references (restoreUnmatchedRefs + sync round trip)', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    const configs = [A];
    // v0.117: the working refs were `useState({})` after a reload. Syncing THAT
    // back would have wiped the stored references — the file's only copy of
    // the K1100T and its <digest>.
    const wiped = withActiveConfigSynced(configs, 'A', A.motors, {});
    expect(wiped[0]!.unmatchedRefs).toBeUndefined();
    // v0.118: the working set is seeded from the active configuration, so the
    // write-back is a no-op and the configuration keeps its references.
    const restored = restoreUnmatchedRefs(configs, 'A', A.motors);
    expect(restored).toEqual({ 'b-mmt': ref('K1100T') });
    expect(withActiveConfigSynced(configs, 'A', A.motors, restored)).toBe(configs);
    // A mount that has a record now is not restored as unmatched: the motor
    // assigned after the import superseded the reference.
    expect(restoreUnmatchedRefs(configs, 'A', { ...A.motors, 'b-mmt': motor('K1100T') })).toEqual({});
    // Nothing to restore from: no configs, no active id, an id that names none, no refs.
    expect(restoreUnmatchedRefs(undefined, 'A', {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, null, {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, undefined, {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, 'Z', {})).toEqual({});
    expect(restoreUnmatchedRefs([cfg('C', {})], 'C', {})).toEqual({});
  });

  it('returns the input by identity when there is no active configuration', () => {
    const configs = [cfg('A', { 's-mmt': motor('J540R') })];
    const working = { 's-mmt': motor('I284W') };
    expect(withActiveConfigSynced(configs, null, working, {})).toBe(configs);
    // An id no configuration has (a preset deleted under it) is the same as none.
    expect(withActiveConfigSynced(configs, 'nope', working, {})).toBe(configs);
    const none: SavedConfig[] = [];
    expect(withActiveConfigSynced(none, 'A', working, {})).toBe(none);
  });
});

describe('migrateLegacyPadMass', () => {
  it('attaches a v0.116 session’s pad mass to the in-tree primary with the legacy key, ignores a record for a deleted mount, reports dropped when no in-tree mount has a motor, and returns a session without one by identity', () => {
    const tree = twoStage();
    // Booster first in the record, a stale record for a mount long deleted:
    // the primary is still the sustainer's, and the stale id never sorts first.
    const motors: Record<string, MountMotor> = {
      'b-mmt': motor('I284W'), gone: motor('G80'), 's-mmt': motor('J540R'),
    };
    const m = migrateLegacyPadMass(motors, 10.574, tree);
    expect(m.outcome).toBe('attached');
    expect(m.mountId).toBe('s-mmt');
    expect(m.kg).toBe(10.574);
    expect(m.motors['s-mmt']).toEqual({ ...motor('J540R'), padMassKg: 10.574, padMassWeighedWith: LEGACY_PAD_MASS_KEY });
    expect(m.motors['b-mmt']).toBe(motors['b-mmt']);
    expect(m.motors['gone']).toBe(motors['gone']);
    expect('padMassKg' in motors['s-mmt']!).toBe(false);          // the input is untouched
    // Only the stale record, or no record at all (the motor was unloaded —
    // Eric's first screenshot): nothing to belong to. Dropped, input by identity.
    const stale = { gone: motor('G80') };
    expect(migrateLegacyPadMass(stale, 7.48, tree)).toEqual({ motors: stale, outcome: 'dropped', kg: 7.48 });
    expect(migrateLegacyPadMass(stale, 7.48, tree).motors).toBe(stale);
    const none = {};
    expect(migrateLegacyPadMass(none, 7.48, tree)).toEqual({ motors: none, outcome: 'dropped', kg: 7.48 });
    // An in-tree id that is not a motor mount (the body tube) is no home either.
    expect(migrateLegacyPadMass({ b1: motor('G80') }, 7.48, tree).outcome).toBe('dropped');
    // A booster-only set attaches to the booster: it is the topmost mount WITH a motor.
    expect(migrateLegacyPadMass({ 'b-mmt': motor('I284W') }, 7.48, tree).mountId).toBe('b-mmt');
    // No legacy value, in every shape a session can carry: identity, 'none'.
    for (const v of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '7.48', {}]) {
      const r = migrateLegacyPadMass(motors, v, tree);
      expect(r.motors, String(v)).toBe(motors);
      expect(r, String(v)).toEqual({ motors, outcome: 'none' });
    }
  });
});

describe('stripPadMass and stripRefPadMass', () => {
  it('remove the keys everywhere and return the input by identity when none carries one', () => {
    // Scale: the rocket that was weighed no longer exists.
    const plain = { 's-mmt': motor('J540R'), 'b-mmt': motor('I284W') };
    expect(stripPadMass(plain)).toBe(plain);
    const weighed: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R'), padMassKg: 10.574, padMassWeighedWith: KEY }, 'b-mmt': motor('I284W'),
    };
    const out = stripPadMass(weighed);
    expect(out).not.toBe(weighed);
    expect(out['s-mmt']).toEqual(motor('J540R'));
    expect('padMassKg' in out['s-mmt']!).toBe(false);
    expect('padMassWeighedWith' in out['s-mmt']!).toBe(false);
    expect(out['b-mmt']).toBe(weighed['b-mmt']);                  // untouched records keep identity
    expect(weighed['s-mmt']!.padMassKg).toBe(10.574);             // the input is untouched
    // Half a record — never written, cleared all the same.
    expect(stripPadMass({ 's-mmt': { ...motor('J540R'), padMassWeighedWith: KEY } })['s-mmt']).toEqual(motor('J540R'));

    const refs = { 'b-mmt': ref('K1100T') };
    expect(stripRefPadMass(refs)).toBe(refs);
    const refsWeighed: Record<string, OrkMotorRef> = {
      'b-mmt': { ...ref('K1100T'), padMassKg: 10.574 }, 'a-mmt': ref('J350W'),
    };
    const o2 = stripRefPadMass(refsWeighed);
    expect(o2).not.toBe(refsWeighed);
    expect(o2['b-mmt']).toEqual(ref('K1100T'));
    expect('padMassKg' in o2['b-mmt']!).toBe(false);
    expect(o2['a-mmt']).toBe(refsWeighed['a-mmt']);
    expect(refsWeighed['b-mmt']!.padMassKg).toBe(10.574);
  });
});

describe('assignMotorRecord — how a weighing survives loading a motor', () => {
  const ctx = (over: Partial<Parameters<typeof assignMotorRecord>[3]> = {}) => ({
    tree: twoStage(), primaryMountId: null as string | null, droppedRef: undefined, remainingRefs: {}, ...over,
  });

  it('the same motor re-picked for a different delay keeps both keys; a different motor starts blank', () => {
    // 2026-09-08 review: the card's delay controls spread the record, but a
    // re-pick through the browser (J460T-10 → J460T-14) replaced it and the
    // field went blank against the guide's "a delay change keeps the weighing".
    const prev: Record<string, MountMotor> = {
      's-mmt': { ...motor('J460T', 10), padMassKg: 7.48, padMassWeighedWith: KEY },
    };
    const same = assignMotorRecord(prev, 's-mmt', motor('J460T', 14), ctx({ primaryMountId: 's-mmt' }));
    expect(same['s-mmt']).toEqual({ ...motor('J460T', 14), padMassKg: 7.48, padMassWeighedWith: KEY });
    expect(same['s-mmt']!.spec.ejectionDelay).toBe(14);
    // A pending legacy value rides along too — the reconcile effect decides it.
    const legacy = { 's-mmt': { ...motor('J460T'), padMassKg: 7.48, padMassWeighedWith: LEGACY_PAD_MASS_KEY } };
    expect(assignMotorRecord(legacy, 's-mmt', motor('J460T', 7), ctx())['s-mmt']!.padMassWeighedWith)
      .toBe(LEGACY_PAD_MASS_KEY);
    // Another motor: a fresh record, no keys — the weighing belonged to the J460T.
    const other = assignMotorRecord(prev, 's-mmt', motor('J350W'), ctx({ primaryMountId: 's-mmt' }));
    expect(other['s-mmt']).toEqual(motor('J350W'));
    expect('padMassKg' in other['s-mmt']!).toBe(false);
    // The input is untouched and other records keep identity.
    expect(prev['s-mmt']!.spec.ejectionDelay).toBe(10);
    const withBooster = { ...prev, 'b-mmt': motor('I284W') };
    expect(assignMotorRecord(withBooster, 's-mmt', motor('J460T', 14), ctx())['b-mmt']).toBe(withBooster['b-mmt']);
  });

  it('the file’s own motor adopts the pad mass the file left on its reference, keyed to the post-assignment set', () => {
    // A .ork whose sustainer K550W could not be matched kept its pad mass on
    // the reference; the card said "Load that motor to use it". Loading it
    // must deliver — before this, the value was deleted and the note told the
    // user to re-weigh with the motor they had just loaded.
    const ref550 = { ...ref('K550W'), padMassKg: 10.574 };
    expect(adoptsRefPadMass(ref550, 'K550W')).toBe(10.574);
    expect(adoptsRefPadMass(ref550, 'k550w')).toBe(10.574);                // findDbMotor's rank-0 rule
    expect(adoptsRefPadMass(ref550, 'J350W')).toBeUndefined();
    expect(adoptsRefPadMass(ref('K550W'), 'K550W')).toBeUndefined();     // no value on the reference
    expect(adoptsRefPadMass({ ...ref('K550W'), padMassKg: 0 }, 'K550W')).toBeUndefined();
    expect(adoptsRefPadMass(undefined, 'K550W')).toBeUndefined();

    // Single mount: the value lands on the new record, keyed to that one motor.
    const alone = assignMotorRecord({}, 's-mmt', motor('K550W'), ctx({ droppedRef: ref550 }));
    expect(alone['s-mmt']!.padMassKg).toBe(10.574);
    expect(alone['s-mmt']!.padMassWeighedWith).toBe('[["s-mmt","AeroTech/K550W",1]]');
    // Staged, booster loaded: the key holds both mounts, so it equals what
    // App's currentSetKey will compute and the value applies at once.
    const booster = { 'b-mmt': motor('I284W') };
    const staged = assignMotorRecord(booster, 's-mmt', motor('K550W'),
      ctx({ primaryMountId: 'b-mmt', droppedRef: ref550 }));
    expect(staged['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","AeroTech/I284W",1],["s-mmt","AeroTech/K550W",1]]');
    expect(staged['b-mmt']).toBe(booster['b-mmt']);
    // Another reference still unmatched rides in as a sentinel, so the line
    // reads "load it to use the pad mass" instead of applying against a
    // sustainer-only catalogue sum; a reference for a mount the tree no
    // longer has is ignored, as the export ignores it.
    const half = assignMotorRecord({}, 's-mmt', motor('K550W'),
      ctx({ droppedRef: ref550, remainingRefs: { 'b-mmt': ref('J350W'), gone: ref('G80') } }));
    expect(half['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","unmatched:J350W",1],["s-mmt","AeroTech/K550W",1]]');
    // A different motor on that mount: fresh record, nothing adopted — the
    // caller drops the reference and says which motor the file weighed with.
    const other = assignMotorRecord({}, 's-mmt', motor('J350W'), ctx({ droppedRef: ref550 }));
    expect(other['s-mmt']).toEqual(motor('J350W'));
  });

  it('the primary’s unmatched: sentinel for the loaded mount is rewritten to the loaded identity, count kept', () => {
    const key = '[["b-mmt","unmatched:I284W",2],["s-mmt","AeroTech/J540R",1]]';
    const prev: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R'), padMassKg: 11.158, padMassWeighedWith: key },
    };
    const out = assignMotorRecord(prev, 'b-mmt', motor('I284W'), ctx({ primaryMountId: 's-mmt' }));
    expect(out['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","AeroTech/I284W",2],["s-mmt","AeroTech/J540R",1]]');
    expect(out['s-mmt']!.padMassKg).toBe(11.158);
    expect(out['b-mmt']).toEqual(motor('I284W'));
    // Case-insensitive, as findDbMotor matches.
    expect(assignMotorRecord(prev, 'b-mmt', motor('i284w'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']!.padMassWeighedWith)
      .toBe('[["b-mmt","AeroTech/i284w",2],["s-mmt","AeroTech/J540R",1]]');
    // A different motor there leaves the sentinel: the line will say the
    // file's motor is not loaded (stale-set 'changed').
    expect(assignMotorRecord(prev, 'b-mmt', motor('J350W'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']).toBe(prev['s-mmt']);
    // A legacy key is never parsed.
    const legacy = { 's-mmt': { ...motor('J540R'), padMassKg: 11.158, padMassWeighedWith: LEGACY_PAD_MASS_KEY } };
    expect(assignMotorRecord(legacy, 'b-mmt', motor('I284W'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']).toBe(legacy['s-mmt']);
  });
});

describe('withoutStoredRef', () => {
  it('assign → remove → reload does not resurrect the file’s motor on a mount the user emptied', () => {
    // 2026-09-08 review: assignMotor dropped the WORKING reference only; the
    // stored row kept it until a switch or save synced the two, and
    // restoreUnmatchedRefs reads the stored row — so a reload put the file's
    // K1100T back on a mount the user had assigned over and then emptied,
    // and Save wrote it.
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    const configs = [A];
    // Assign a motor to b-mmt: the working ref goes, and now the stored one.
    const assigned = withoutStoredRef(configs, 'A', 'b-mmt');
    expect(assigned).not.toBe(configs);
    expect('unmatched' in assigned[0]!).toBe(false);
    expect('unmatchedRefs' in assigned[0]!).toBe(false);
    expect(assigned[0]!.motors).toBe(A.motors);                        // the rest of the row untouched
    expect(A.unmatchedRefs!['b-mmt']).toBeDefined();                    // the input is untouched
    // ✕ Remove on b-mmt, then a reload: nothing to seed the working set from.
    expect(restoreUnmatchedRefs(assigned, 'A', { 's-mmt': motor('J540R') })).toEqual({});
    // Whereas the un-dropped row would have brought it back.
    expect(restoreUnmatchedRefs(configs, 'A', { 's-mmt': motor('J540R') })).toEqual({ 'b-mmt': ref('K1100T') });
  });

  it('keeps the other references in order, and returns the input by identity when there is nothing to drop', () => {
    const refs: Record<string, OrkMotorRef> = {};
    refs['b-mmt'] = ref('K1100T');
    refs['a-mmt'] = ref('J350W');
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T', 'J350W'], unmatchedRefs: refs });
    const B = cfg('B', {});
    const out = withoutStoredRef([A, B], 'A', 'b-mmt');
    expect(out[0]!.unmatched).toEqual(['J350W']);
    expect(out[0]!.unmatchedRefs).toEqual({ 'a-mmt': ref('J350W') });
    expect(out[1]).toBe(B);
    // Identity: no active row, an id no row has, a row without refs, a mount the row has no ref for.
    const configs = [A, B];
    expect(withoutStoredRef(configs, null, 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'Z', 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'B', 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'A', 's-mmt')).toBe(configs);
  });
});
