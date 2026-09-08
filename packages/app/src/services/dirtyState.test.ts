import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import { withActiveConfigSynced } from './configSync.js';

const tree = (name = 'My Rocket'): RocketTree => ({
  name,
  components: [{
    type: 'stage', id: 's', children: [
      { type: 'nosecone', id: 'nc', length: 0.1, aftRadius: 0.012, shape: 'ogive' },
      { type: 'bodytube', id: 'bt', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
    ],
  }],
} as unknown as RocketTree);

const base = (): DesignSnapshot => ({
  tree: tree(),
  mountMotors: {},
  launch: { windAvg: 3, timeStepS: 0.01 } as unknown as DesignSnapshot['launch'],
  maxMotorLengthByStage: {},
  savedConfigs: [],
  activeConfigId: null,
  measured: { massKg: null, cgM: null },
});

describe('designFingerprint', () => {
  it('is the same for an identical snapshot', () => {
    expect(designFingerprint(base())).toBe(designFingerprint(base()));
  });

  it('changes when ONLY the rocket name changes', () => {
    const b = base();
    const renamed = { ...b, tree: tree('Big Rocket') };
    expect(designFingerprint(renamed)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a launch condition changes', () => {
    const b = base();
    const windy = { ...b, launch: { ...b.launch, windAvg: 9 } };
    expect(designFingerprint(windy)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a motor changes', () => {
    const b = base();
    const motored = {
      ...b,
      mountMotors: { bt: { label: 'C6-5' } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    expect(designFingerprint(motored)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY the measured mass changes', () => {
    const b = base();
    const weighed = { ...b, measured: { massKg: 0.051, cgM: null } };
    expect(designFingerprint(weighed)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a per-stage motor length limit changes', () => {
    const b = base();
    const limited = { ...b, maxMotorLengthByStage: { s: 0.3 } };
    expect(designFingerprint(limited)).not.toBe(designFingerprint(b));
  });

  it('does NOT change when Record keys arrive in a different order', () => {
    // This is the test that pins the sort in `stableJson()`. An import builds
    // mountMotors in file order and editing builds it in click order; without
    // the sort the same design fingerprints two ways and the prompt fires on a
    // file the user has only just saved. Delete the sort and this is the ONLY
    // assertion in the file that fails — every other one still passes.
    const m1 = { a: { label: 'C6-5' }, b: { label: 'D12-3' } };
    const m2: typeof m1 = {} as typeof m1;
    (m2 as Record<string, unknown>)['b'] = { label: 'D12-3' };
    (m2 as Record<string, unknown>)['a'] = { label: 'C6-5' };
    expect(Object.keys(m1).join()).not.toBe(Object.keys(m2).join()); // the premise
    const s1 = { ...base(), mountMotors: m1 as unknown as DesignSnapshot['mountMotors'] };
    const s2 = { ...base(), mountMotors: m2 as unknown as DesignSnapshot['mountMotors'] };
    expect(designFingerprint(s1)).toBe(designFingerprint(s2));
  });

  it('tells a plugged motor from an absent delay', () => {
    // A plugged motor carries ejectionDelay = Infinity, which plain JSON turns
    // into null — the same text an absent delay produces. Without the Infinity
    // mapping, plugging a motor would not register as a change at all.
    const plugged = {
      ...base(),
      mountMotors: { bt: { ejectionDelay: Infinity } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    const absent = {
      ...base(),
      mountMotors: { bt: { ejectionDelay: null } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    expect(designFingerprint(plugged)).not.toBe(designFingerprint(absent));
  });
});

describe('designFingerprint — the weighed pad mass on the motor record (v0.118)', () => {
  const motor = (designation: string, delay = 10): MountMotor => ({
    label: `${designation}-${delay}`,
    spec: {
      designation, diameter: 0.054, length: 0.41, cgX: 0.2, ejectionDelay: delay,
      times: [0, 1], thrusts: [0, 0], masses: [1.084, 0.6],
    },
    meta: { label: designation, manufacturer: 'AeroTech' },
    ignition: { event: 'automatic', delay: 0 },
  });
  const key = '[["mmt","AeroTech/J540R",1]]';

  it('a record that gains padMassKg fingerprints differently, and one whose two keys were deleted fingerprints as it did before they were added', () => {
    const rec = motor('J540R');
    const before = designFingerprint({ ...base(), mountMotors: { mmt: rec } });
    const weighed: MountMotor = { ...rec, padMassKg: 10.574, padMassWeighedWith: key };
    expect(designFingerprint({ ...base(), mountMotors: { mmt: weighed } })).not.toBe(before);
    // Clearing DELETES both keys — the key-only-when-set rule. stableJson hashes
    // keys, so this is the only shape that reads as "back where it was".
    const { padMassKg: _p, padMassWeighedWith: _w, ...cleared } = weighed;
    expect(designFingerprint({ ...base(), mountMotors: { mmt: cleared } })).toBe(before);
    // The trap the rule exists for: a null value is NOT absent. Writing null
    // on clear would read as unsaved forever (the v0.116 register limit).
    const nulled = { ...rec, padMassKg: null } as unknown as MountMotor;
    expect(designFingerprint({ ...base(), mountMotors: { mmt: nulled } })).not.toBe(before);
  });

  it('a save, a switch to another configuration and a switch back fingerprints as the mark (savedConfigs synced before the mark)', () => {
    const cfgA: SavedConfig = { id: 'A', name: 'A', isDefault: true, motors: { mmt: motor('J540R') } };
    const cfgB: SavedConfig = { id: 'B', name: 'B', isDefault: false, motors: { mmt: motor('I284W') } };
    const configs = [cfgA, cfgB];
    // The working set: A with a delay edit and a pad mass typed.
    const working: Record<string, MountMotor> = {
      mmt: { ...motor('J540R', 7), padMassKg: 10.574, padMassWeighedWith: key },
    };
    const snap = (mountMotors: Record<string, MountMotor>, savedConfigs: SavedConfig[], activeConfigId: string) =>
      designFingerprint({ ...base(), mountMotors, savedConfigs, activeConfigId });

    // Save: onSaveOrk syncs the working set into A, then takes the mark.
    const synced = withActiveConfigSynced(configs, 'A', working, {});
    const mark = snap(working, synced, 'A');
    // Switch to B: applyConfig syncs first (already synced → identity), then swaps.
    const s2 = withActiveConfigSynced(synced, 'A', working, {});
    expect(s2).toBe(synced);
    // Switching AWAY alone is a change, as today: activeConfigId and mountMotors are hashed.
    expect(snap(cfgB.motors, s2, 'B')).not.toBe(mark);
    // Switch back: B is unchanged (identity), and A comes back from its SYNCED row.
    const s3 = withActiveConfigSynced(s2, 'B', cfgB.motors, {});
    expect(s3).toBe(s2);
    expect(snap(s3.find((c) => c.id === 'A')!.motors, s3, 'A')).toBe(mark);
    // Without the sync (v0.117) coming back restored A's import snapshot: the
    // delay edit and the pad mass were gone, and the mark was missed.
    expect(snap(cfgA.motors, configs, 'A')).not.toBe(mark);
  });
});

describe('isDirty', () => {
  it('is clean when the mark matches and nothing has flown', () => {
    expect(isDirty('abc', 'abc', false)).toBe(false);
  });

  it('is dirty when the design has moved on from the mark', () => {
    expect(isDirty('abc', 'xyz', false)).toBe(true);
  });

  it('is dirty after a flight even though the design is unchanged', () => {
    // The owner asked for this explicitly: "detect if the user made any changes
    // (including flying a sim)". A flight does not touch the tree, so the
    // fingerprint alone can never see it.
    expect(isDirty('abc', 'abc', true)).toBe(true);
  });

  it('treats an unknown mark as dirty rather than as saved', () => {
    // A session written by a build before this field existed cannot prove it
    // was saved. "I do not know" must ask, not discard.
    expect(isDirty('abc', null, false)).toBe(true);
    expect(isDirty('abc', undefined, false)).toBe(true);
    expect(isDirty('abc', '', false)).toBe(true);
  });
});
